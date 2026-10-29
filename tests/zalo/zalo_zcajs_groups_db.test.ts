/**
 * ZCAJS group ingestion regression on real PostgreSQL (PGlite, all migrations).
 *
 * Verifies the DB contract that the CRM route depends on:
 * - group conversations/customers are created under the `group:` namespace
 * - `is_group` metadata persists so the AI enqueue trigger skips groups
 * - observed group outbound creates/repairs the identity and group display name
 *
 * Run: npx tsx --conditions=react-server tests/zalo/zalo_zcajs_groups_db.test.ts
 */
import assert from 'node:assert/strict';
import { createPgliteSupabase } from './helpers/pglite-supabase';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_THREAD = 'group:123456789012345678';
const GROUP_ID = '123456789012345678';
const OTHER_GROUP_THREAD = 'group:987654321098765432';
const OTHER_GROUP_ID = '987654321098765432';

async function main() {
  const pg = await createPgliteSupabase();
  const { db, client } = pg;
  try {
    await db.exec(`
      INSERT INTO public.companies (id, name) VALUES ('${COMPANY_ID}', 'ZCAJS Group Co');
      INSERT INTO public.ai_brain_live_settings (company_id, channel, enabled)
      VALUES ('${COMPANY_ID}', 'ZALO', true);
    `);

    const inbound = await client.rpc('ingest_provider_message_atomic', {
      p_company_id: COMPANY_ID,
      p_channel: 'ZALO',
      p_external_user_id: GROUP_THREAD,
      p_sender_name: 'Nhóm khách biệt thự',
      p_external_conversation_id: GROUP_THREAD,
      p_external_ref: `zcajs:group:g-in-1`,
      p_sanitized_content: 'Anh Nam: Còn hàng không shop?',
      p_raw_content: 'Anh Nam: Còn hàng không shop?',
      p_source_metadata: {
        transport: 'ZCAJS',
        is_group: true,
        group_id: GROUP_ID,
        group_name: 'Nhóm khách biệt thự',
      },
      p_sanitization_status: 'SUCCEEDED',
    });
    assert.equal(inbound.error, null, JSON.stringify(inbound.error));

    const conversation = (
      await db.query<{
        id: string;
        customer_id: string;
        external_conversation_id: string;
        metadata: Record<string, unknown>;
        ai_mode: string;
      }>(
        `SELECT id, customer_id, external_conversation_id, metadata, ai_mode
           FROM public.conversations
          WHERE company_id = $1 AND external_conversation_id = $2`,
        [COMPANY_ID, GROUP_THREAD]
      )
    ).rows[0];
    assert.ok(conversation, 'group conversation exists');
    assert.equal(conversation.external_conversation_id, GROUP_THREAD);
    assert.equal(conversation.metadata.is_group, true);
    assert.equal(conversation.metadata.group_id, GROUP_ID);
    assert.equal(conversation.metadata.group_name, 'Nhóm khách biệt thự');

    const customer = (
      await db.query<{ name: string }>(
        `SELECT name FROM public.customers WHERE id = $1`,
        [conversation.customer_id]
      )
    ).rows[0];
    assert.equal(customer.name, 'Nhóm khách biệt thự');

    const identity = (
      await db.query<{ external_id: string }>(
        `SELECT external_id FROM public.identities
          WHERE company_id = $1 AND channel = 'ZALO' AND external_id = $2`,
        [COMPANY_ID, GROUP_THREAD]
      )
    ).rows[0];
    assert.equal(identity.external_id, GROUP_THREAD);

    const aiDelivery = (
      await db.query<{ id: string }>(
        `SELECT id FROM public.ai_brain_live_deliveries WHERE conversation_id = $1`,
        [conversation.id]
      )
    ).rows;
    assert.equal(aiDelivery.length, 0, 'AI must not enqueue a reply for a Zalo group');

    // A direct message still enqueues normally while the channel setting is on.
    const direct = await client.rpc('ingest_provider_message_atomic', {
      p_company_id: COMPANY_ID,
      p_channel: 'ZALO',
      p_external_user_id: '900001',
      p_sender_name: 'Chị Mai',
      p_external_conversation_id: '900001',
      p_external_ref: 'm-direct-1',
      p_sanitized_content: 'Chị Mai: cho em hỏi giá',
      p_raw_content: 'Chị Mai: cho em hỏi giá',
      p_source_metadata: { transport: 'ZCAJS' },
      p_sanitization_status: 'SUCCEEDED',
    });
    assert.equal(direct.error, null, JSON.stringify(direct.error));
    const directConv = (
      await db.query<{ id: string }>(
        `SELECT id FROM public.conversations
          WHERE company_id = $1 AND external_conversation_id = '900001'`,
        [COMPANY_ID]
      )
    ).rows[0];
    const directAi = (
      await db.query<{ id: string }>(
        `SELECT id FROM public.ai_brain_live_deliveries WHERE conversation_id = $1`,
        [directConv.id]
      )
    ).rows;
    assert.equal(directAi.length, 1, 'direct Zalo messages still enqueue AI deliveries');

    // Observed native outbound for a different group creates the thread,
    // identity and display name even before the first inbound message.
    const observed = await client.rpc('record_observed_zcajs_outbound_atomic', {
      p_company_id: COMPANY_ID,
      p_external_conversation_id: OTHER_GROUP_THREAD,
      p_provider_msg_id: 'g-out-1',
      p_sanitized_content: 'Bạn: Dạ em gửi báo giá ạ',
      p_raw_content: 'Bạn: Dạ em gửi báo giá ạ',
      p_source_metadata: {
        transport: 'ZCAJS',
        is_group: true,
        group_id: OTHER_GROUP_ID,
        group_name: 'Nhóm đại lý',
      },
      p_timestamp: new Date().toISOString(),
    });
    assert.equal(observed.error, null, JSON.stringify(observed.error));

    const observedConversation = (
      await db.query<{
        customer_id: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT customer_id, metadata FROM public.conversations
          WHERE company_id = $1 AND external_conversation_id = $2`,
        [COMPANY_ID, OTHER_GROUP_THREAD]
      )
    ).rows[0];
    assert.equal(observedConversation.metadata.is_group, true);
    assert.equal(observedConversation.metadata.group_name, 'Nhóm đại lý');
    assert.equal(observedConversation.metadata.zalo_display_name, 'Nhóm đại lý');

    const observedCustomer = (
      await db.query<{ name: string }>(
        `SELECT name FROM public.customers WHERE id = $1`,
        [observedConversation.customer_id]
      )
    ).rows[0];
    assert.equal(observedCustomer.name, 'Nhóm đại lý');

    const observedIdentity = (
      await db.query<{ external_id: string }>(
        `SELECT external_id FROM public.identities
          WHERE company_id = $1 AND channel = 'ZALO' AND external_id = $2`,
        [COMPANY_ID, OTHER_GROUP_THREAD]
      )
    ).rows[0];
    assert.equal(observedIdentity.external_id, OTHER_GROUP_THREAD);

    console.log('ZCAJS group DB contract: PASS');
  } finally {
    await pg.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
