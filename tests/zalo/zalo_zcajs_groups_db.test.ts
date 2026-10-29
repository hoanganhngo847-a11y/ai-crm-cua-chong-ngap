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
import { syncZaloGroup } from '../../features/omnichannel/zalo/group-sync';
import { getMessagesByConversationId } from '../../features/inbox/services/inbox.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_THREAD = 'group:123456789012345678';
const GROUP_ID = '123456789012345678';
const OTHER_GROUP_THREAD = 'group:987654321098765432';
const OTHER_GROUP_ID = '987654321098765432';

async function main() {
  process.env.DEMO_MODE = 'false';
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

    const refreshed = await syncZaloGroup({
      client, companyId: COMPANY_ID, conversationId: conversation.id,
      workerUrl: 'https://worker.test', workerSecret: 'test-secret',
      fetchImpl: async (url) => {
        assert.match(String(url), /refresh=1/);
        return new Response(JSON.stringify({ success: true, group: {
          groupId: GROUP_ID, groupName: 'Tên nhóm trên Zalo PC', totalMember: 3,
          members: [{ id: '11111', name: 'Anh Nam' }, { id: '22222', name: 'Chị Lan' }, { id: '33333', name: '' }],
          membersComplete: false, fetchedAt: '2026-10-29T10:00:00.000Z',
        } }), { status: 200 });
      },
    });
    assert.equal(refreshed.success, true);
    assert.equal(refreshed.stale, false);
    assert.equal(refreshed.group?.totalMember, 3);
    assert.equal(refreshed.group?.members.length, 3, 'unresolved members must remain visible');
    assert.equal((await db.query<{ name: string }>('SELECT name FROM customers WHERE id=$1', [conversation.customer_id])).rows[0].name, 'Tên nhóm trên Zalo PC');
    await client.rpc('sync_zalo_group_metadata', { p_company_id: COMPANY_ID, p_conversation_id: conversation.id, p_group: {
      group_name: 'Thông tin quá cũ', group_fetched_at: '2026-10-29T09:00:00.000Z', members: [],
    } });
    const cached = await syncZaloGroup({ client, companyId: COMPANY_ID, conversationId: conversation.id, workerUrl: '', workerSecret: '' });
    assert.equal(cached.stale, true);
    assert.equal(cached.group?.groupName, 'Tên nhóm trên Zalo PC');
    assert.equal(cached.group?.members.length, 3);
    const denied = await syncZaloGroup({ client, companyId: '22222222-2222-4222-8222-222222222222', conversationId: conversation.id, workerUrl: '', workerSecret: '' });
    assert.equal(denied.success, false);

    const recoveredAt = new Date(Date.now() - 3 * 86400000).toISOString();
    const recovered = await client.rpc('ingest_zcajs_message_atomic', {
      p_company_id: COMPANY_ID, p_channel: 'ZALO', p_external_user_id: '900001',
      p_external_conversation_id: '900001', p_external_ref: 'history-dm-1',
      p_sanitized_content: 'Tin nhắn đã có từ trước', p_raw_content: 'Tin nhắn đã có từ trước',
      p_source_metadata: { transport: 'ZCAJS', recovered: true, provider_timestamp: recoveredAt },
    });
    assert.equal(recovered.error, null, JSON.stringify(recovered.error));
    const recoveryRows = (await db.query<{ created_at: Date; ai_count: number }>(`SELECT i.created_at,
      (SELECT count(*)::int FROM ai_brain_live_deliveries d WHERE d.source_interaction_id=i.id) AS ai_count
      FROM interactions i WHERE external_ref='history-dm-1'`)).rows;
    assert.equal(new Date(recoveryRows[0].created_at).toISOString(), recoveredAt);
    assert.equal(recoveryRows[0].ai_count, 0, 'history recovery must never enqueue a reply');

    const authorMessage = await client.rpc('ingest_zcajs_message_atomic', {
      p_company_id: COMPANY_ID, p_channel: 'ZALO', p_external_user_id: GROUP_THREAD,
      p_external_conversation_id: GROUP_THREAD, p_external_ref: 'zcajs:group:author-message',
      p_sanitized_content: 'Nam: Kỹ thuật: chào nhóm', p_raw_content: 'Nam: Kỹ thuật: chào nhóm',
      p_source_metadata: { transport: 'ZCAJS', is_group: true, zalo_sender_name: 'Nam: Kỹ thuật', zalo_sender_id: '123456789012345678' },
    });
    assert.equal(authorMessage.error, null, JSON.stringify(authorMessage.error));
    const groupMessages = await getMessagesByConversationId(COMPANY_ID, conversation.id, 'SALE', client);
    const authored = groupMessages.find((m) => m.content === 'chào nhóm');
    assert.equal(authored?.sender_name, 'Nam: Kỹ thuật');
    assert.equal(authored?.sender_external_id, '123456789012345678');
    assert.equal(authored?.raw_content, undefined);
    const repaired = await client.rpc('repair_zalo_group_message_author', {
      p_company_id: COMPANY_ID, p_conversation_id: conversation.id, p_external_ref: 'zcajs:group:g-in-1',
      p_author: { group_id: GROUP_ID, zalo_sender_id: '44444', zalo_sender_name: 'Anh Nam mới' },
    });
    assert.equal(repaired.error, null, JSON.stringify(repaired.error));
    const repairedMessages = await getMessagesByConversationId(COMPANY_ID, conversation.id, 'SALE', client);
    assert.equal(repairedMessages.find((m) => m.sender_external_id === '44444')?.content, 'Còn hàng không shop?');
    const otherTenantAuthors = await client.rpc('get_zalo_group_message_authors', { p_company_id: '22222222-2222-4222-8222-222222222222', p_interaction_ids: [authored!.id] });
    assert.deepEqual(otherTenantAuthors.data, []);
    const acl = (await db.query<{ allowed: boolean }>(`SELECT has_function_privilege('authenticated', 'public.get_zalo_group_message_authors(uuid,uuid[])', 'execute') AS allowed`)).rows[0];
    assert.equal(acl.allowed, false);

    // A conversation with >1000 messages must expose its newest messages and
    // paginate through timestamp ties without skipping or duplicating any ID.
    await db.query(`INSERT INTO interactions (company_id, customer_id, conversation_id, channel, type, direction, actor_type,
      sanitized_content, sanitization_status, created_at)
      SELECT $1, $2, $3, 'ZALO', 'MESSAGE', 'INBOUND', 'CUSTOMER', 'Anh Nam: lịch sử ' || n, 'SUCCEEDED', '2026-10-29T12:00:00Z'
      FROM generate_series(1, 1100) n`, [COMPANY_ID, conversation.customer_id, conversation.id]);
    let before: { id: string; createdAt: string } | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const messages = await getMessagesByConversationId(COMPANY_ID, conversation.id, 'SALE', client, { pageSize: 100, before });
      for (const message of messages) { assert.ok(!seen.has(message.id)); seen.add(message.id); }
      if (messages.length < 100) break;
      before = { id: messages[0].id, createdAt: messages[0].created_at };
    }
    assert.equal(seen.size, 1102);
    console.log('ZCAJS group metadata, authors, recovery safety, and history pagination: PASS');
  } finally {
    await pg.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
