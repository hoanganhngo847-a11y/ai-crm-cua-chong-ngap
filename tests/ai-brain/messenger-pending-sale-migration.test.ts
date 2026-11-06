import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

const PAGE_A = '1343097708890171';
const PAGE_B = '1026991374010112';
const OTHER_PAGE = '123456789012345';

test('Messenger PENDING_SALE migration seeds only approved Pages and preserves tenant kill switches', async () => {
  const harness = await createPgliteSupabase();
  const { db, client } = harness;
  const companyEnabled = randomUUID();
  const companyDisabled = randomUUID();
  const companyOther = randomUUID();
  const customers = [randomUUID(), randomUUID(), randomUUID()];

  try {
    await db.query(
      `INSERT INTO public.companies (id, name, status)
       VALUES ($1, 'Messenger approved Page A', 'ACTIVE'),
              ($2, 'Messenger approved Page B disabled', 'ACTIVE'),
              ($3, 'Messenger unrelated Page', 'ACTIVE')`,
      [companyEnabled, companyDisabled, companyOther],
    );
    await db.query(
      `INSERT INTO public.customers (id, company_id, customer_code, name, source, stage)
       VALUES ($1, $2, 'MSGR-A', 'Messenger A', 'MANUAL', 'LEAD_NEW'),
              ($3, $4, 'MSGR-B', 'Messenger B', 'MANUAL', 'LEAD_NEW'),
              ($5, $6, 'MSGR-C', 'Messenger C', 'MANUAL', 'LEAD_NEW')`,
      [customers[0], companyEnabled, customers[1], companyDisabled, customers[2], companyOther],
    );
    await db.query(
      `INSERT INTO public.ai_brain_live_settings (company_id, channel, enabled, min_confidence)
       VALUES ($1, 'MESSENGER', false, 0.700)`,
      [companyDisabled],
    );

    const conversations = [
      { id: randomUUID(), company_id: companyEnabled, customer_id: customers[0], page: PAGE_B, psid: '87654321098765001' },
      { id: randomUUID(), company_id: companyDisabled, customer_id: customers[1], page: PAGE_A, psid: '87654321098765002' },
      { id: randomUUID(), company_id: companyOther, customer_id: customers[2], page: OTHER_PAGE, psid: '87654321098765003' },
    ];
    for (const c of conversations) {
      const { error } = await client.from('conversations').insert({
        id: c.id,
        company_id: c.company_id,
        customer_id: c.customer_id,
        channel: 'FACEBOOK',
        external_conversation_id: `${c.page}:${c.psid}`,
        status: 'PENDING_SALE',
        ai_mode: 'ACTIVE',
      });
      assert.ifError(error);
    }

    const { rows: canaries } = await db.query<{ company_id: string; page_id: string; enabled: boolean }>(
      `SELECT company_id, page_id, enabled FROM public.ai_brain_live_canary_allowlist
       WHERE conversation_id = ANY($1::uuid[])`,
      [conversations.map(c => c.id)],
    );
    assert.equal(canaries.length, 2);
    assert.ok(canaries.every(c => c.enabled === true));
    assert.ok(canaries.some(c => c.company_id === companyEnabled && c.page_id === PAGE_B));
    assert.ok(canaries.some(c => c.company_id === companyDisabled && c.page_id === PAGE_A));

    const { rows: settings } = await db.query<{ company_id: string; enabled: boolean; min_confidence: number }>(
      `SELECT company_id, enabled, min_confidence FROM public.ai_brain_live_settings
       WHERE channel = 'MESSENGER' AND company_id = ANY($1::uuid[])`,
      [[companyEnabled, companyDisabled, companyOther]],
    );
    const enabledSetting = settings.find(s => s.company_id === companyEnabled);
    const disabledSetting = settings.find(s => s.company_id === companyDisabled);
    assert.equal(enabledSetting?.enabled, true);
    assert.equal(Number(enabledSetting?.min_confidence), 0.700);
    assert.equal(disabledSetting?.enabled, false, 'explicit tenant kill switch must remain off');
    assert.equal(settings.some(s => s.company_id === companyOther), false, 'unapproved Page must not create Messenger settings');

    const interactionId = randomUUID();
    const { error: interactionError } = await client.from('interactions').insert({
      id: interactionId,
      company_id: companyEnabled,
      customer_id: customers[0],
      conversation_id: conversations[0].id,
      channel: 'FACEBOOK',
      type: 'MESSAGE',
      direction: 'INBOUND',
      actor_type: 'CUSTOMER',
      sanitized_content: 'Tôi cần tư vấn ngay',
      sanitization_status: 'SUCCEEDED',
    });
    assert.ifError(interactionError);
    const { rows: deliveries } = await db.query(
      `SELECT id FROM public.ai_brain_live_deliveries WHERE source_interaction_id = $1`,
      [interactionId],
    );
    assert.equal(deliveries.length, 1, 'Messenger PENDING_SALE should enqueue on approved and enabled Page');
  } finally {
    await harness.close();
  }
});
