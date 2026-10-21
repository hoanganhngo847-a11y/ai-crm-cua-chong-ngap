import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPgliteSupabase } from '../zalo/helpers/pglite-supabase';

async function main() {
  console.log('--- Starting PGlite Outbound Customer Metadata Regression Test ---');
  const h = await createPgliteSupabase();
  const db = h.db;

  const companyA = randomUUID();
  const companyB = randomUUID();

  const saleUserA = randomUUID();
  const saleUserB = randomUUID();
  const inactiveUserA = randomUUID();

  const customerA = randomUUID();
  const customerB = randomUUID();

  const convA = randomUUID();
  const convB = randomUUID();

  try {
    // 1. Seed companies
    await db.query(`INSERT INTO public.companies (id, name, status) VALUES ($1, 'Company A', 'ACTIVE')`, [companyA]);
    await db.query(`INSERT INTO public.companies (id, name, status) VALUES ($1, 'Company B', 'ACTIVE')`, [companyB]);

    // 2. Seed users and profiles
    for (const [uid, name] of [
      [saleUserA, 'Sale User A'],
      [saleUserB, 'Sale User B'],
      [inactiveUserA, 'Inactive User A'],
    ]) {
      await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [uid]);
      await db.query(`INSERT INTO public.user_profiles (id, full_name, status) VALUES ($1, $2, 'ACTIVE') ON CONFLICT (id) DO NOTHING`, [uid, name]);
    }

    // 3. Seed company members
    await db.query(
      `INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ($1, $2, 'SALE', 'ACTIVE')`,
      [companyA, saleUserA]
    );
    await db.query(
      `INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ($1, $2, 'SALE', 'ACTIVE')`,
      [companyB, saleUserB]
    );
    await db.query(
      `INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ($1, $2, 'SALE', 'INACTIVE')`,
      [companyA, inactiveUserA]
    );

    // 4. Seed customers
    await db.query(
      `INSERT INTO public.customers (id, company_id, name, customer_code, stage, source)
       VALUES ($1, $2, 'Nguyễn Văn A Canonical', 'CUST-A-001', 'LEAD_NEW', 'FACEBOOK')`,
      [customerA, companyA]
    );
    await db.query(
      `INSERT INTO public.customers (id, company_id, name, customer_code, stage, source)
       VALUES ($1, $2, 'Trần Thị B Canonical', 'CUST-B-001', 'LEAD_NEW', 'FACEBOOK')`,
      [customerB, companyB]
    );

    // 5. Seed conversations
    await db.query(
      `INSERT INTO public.conversations (
         id, company_id, customer_id, channel, external_conversation_id, status, metadata
       ) VALUES ($1, $2, $3, 'FACEBOOK', 'ext-fb-conv-a', 'OPEN', $4)`,
      [
        convA,
        companyA,
        customerA,
        JSON.stringify({
          provider: 'facebook_browser',
          page_id: 'page_123',
          page_name: 'Antigravity Shop',
          customer_fb_id: 'fb_user_456',
          external_conversation_id: 'ext-fb-conv-a',
        }),
      ]
    );

    await db.query(
      `INSERT INTO public.conversations (
         id, company_id, customer_id, channel, external_conversation_id, status, metadata
       ) VALUES ($1, $2, $3, 'FACEBOOK', 'ext-fb-conv-b', 'OPEN', $4)`,
      [
        convB,
        companyB,
        customerB,
        JSON.stringify({
          provider: 'facebook_browser',
          page_id: 'page_999',
          page_name: 'Other Shop',
          customer_fb_id: 'fb_user_999',
          external_conversation_id: 'ext-fb-conv-b',
        }),
      ]
    );

    console.log('Seeded test fixtures successfully.');

    // --- TEST 1: Canonical Name Metadata & Untrusted Metadata Protection ---
    console.log('Executing Test 1: Canonical customer name resolution and metadata safety');
    const cmd1 = randomUUID();
    const res1 = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_customer_id: null,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Chào anh/chị, em gửi thông tin báo giá.',
      p_raw_content: 'Chào anh/chị, em gửi thông tin báo giá.',
      p_sanitization_status: 'SUCCEEDED',
      p_source_metadata: {
        customer_name: 'ATTACKER_INJECTED_NAME',
        untrusted_field: 'malicious',
      },
      p_client_command_id: cmd1,
      p_actor_user_id: saleUserA,
    });

    assert.ifError(res1.error);
    assert.ok(res1.data);
    assert.equal(res1.data.is_duplicate, false);

    // Verify outbound_deliveries record
    const deliveryRows = (await db.query(
      `SELECT * FROM public.outbound_deliveries WHERE id = $1`,
      [res1.data.delivery_id]
    )).rows as any[];
    assert.equal(deliveryRows.length, 1);
    const delivery = deliveryRows[0];
    const deliveryMeta = typeof delivery.metadata === 'string' ? JSON.parse(delivery.metadata) : delivery.metadata;

    assert.equal(deliveryMeta.customer_name, 'Nguyễn Văn A Canonical', 'Must resolve canonical customer name from public.customers');
    assert.notEqual(deliveryMeta.customer_name, 'ATTACKER_INJECTED_NAME', 'Must never use untrusted customer_name from metadata');
    assert.equal(deliveryMeta.page_id, 'page_123');
    assert.equal(deliveryMeta.page_name, 'Antigravity Shop');
    assert.equal(deliveryMeta.customer_fb_id, 'fb_user_456');
    assert.equal(deliveryMeta.external_conversation_id, 'ext-fb-conv-a');
    console.log('✓ Test 1 passed: Canonical name properly resolved, untrusted input rejected.');

    // --- TEST 2: Duplicate Idempotence ---
    console.log('Executing Test 2: Idempotent resend with same client_command_id');
    const res2 = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_customer_id: null,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Chào anh/chị, em gửi thông tin báo giá.',
      p_raw_content: 'Chào anh/chị, em gửi thông tin báo giá.',
      p_sanitization_status: 'SUCCEEDED',
      p_source_metadata: {
        customer_name: 'ATTACKER_INJECTED_NAME',
        untrusted_field: 'malicious',
      },
      p_client_command_id: cmd1,
      p_actor_user_id: saleUserA,
    });
    assert.ifError(res2.error);
    assert.equal(res2.data.is_duplicate, true, 'Subsequent call with identical payload must return is_duplicate = true');
    assert.equal(res2.data.interaction_id, res1.data.interaction_id, 'Must return same interaction_id');
    assert.equal(res2.data.delivery_id, res1.data.delivery_id, 'Must return same delivery_id');
    console.log('✓ Test 2 passed: Idempotency returns duplicate record.');

    // --- TEST 3: Changed Payload Conflict ---
    console.log('Executing Test 3: Reusing client_command_id with modified payload');
    const res3 = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_customer_id: null,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Nội dung này hoàn toàn khác biệt!',
      p_raw_content: 'Nội dung này hoàn toàn khác biệt!',
      p_sanitization_status: 'SUCCEEDED',
      p_source_metadata: {},
      p_client_command_id: cmd1,
      p_actor_user_id: saleUserA,
    });
    assert.ok(res3.error, 'Reused client_command_id with changed payload must fail');
    assert.equal(res3.error.code, 'P0001');
    assert.ok(res3.error.message.includes('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
    console.log('✓ Test 3 passed: Payload conflict rejected with code P0001.');

    // --- TEST 4: Actor Attribution & Authorization ---
    console.log('Executing Test 4: Actor attribution and authorization checks');
    // Verify actor stored on interaction
    const interactionRows = (await db.query(
      `SELECT * FROM public.interactions WHERE id = $1`,
      [res1.data.interaction_id]
    )).rows as any[];
    assert.equal(interactionRows.length, 1);
    assert.equal(interactionRows[0].actor_user_id, saleUserA);
    assert.equal(interactionRows[0].actor_type, 'SALE');

    // Unauthorized actor: Unknown user UUID
    const res4Bad = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Actor auth test',
      p_client_command_id: randomUUID(),
      p_actor_user_id: randomUUID(),
    });
    assert.ok(res4Bad.error, 'Unregistered actor must be rejected');
    assert.equal(res4Bad.error.code, '42501');
    assert.ok(res4Bad.error.message.includes('ACTOR_NOT_AUTHORIZED'));

    // Inactive actor: SUSPENDED/INACTIVE member
    const res4Inactive = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Inactive actor test',
      p_client_command_id: randomUUID(),
      p_actor_user_id: inactiveUserA,
    });
    assert.ok(res4Inactive.error, 'Inactive member must be rejected');
    assert.equal(res4Inactive.error.code, '42501');
    assert.ok(res4Inactive.error.message.includes('ACTOR_NOT_AUTHORIZED'));
    console.log('✓ Test 4 passed: Actor attribution and role checks validated.');

    // --- TEST 5: Cross-Tenant Isolation ---
    console.log('Executing Test 5: Cross-tenant boundary isolation');
    // Tenant B accessing Conversation A
    const res5CrossConv = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyB,
      p_conversation_id: convA,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Cross-tenant conv attack',
      p_client_command_id: randomUUID(),
      p_actor_user_id: saleUserB,
    });
    assert.ok(res5CrossConv.error, 'Cross-tenant conversation access must be rejected');
    assert.equal(res5CrossConv.error.code, 'P0002');
    assert.ok(res5CrossConv.error.message.includes('CONVERSATION_NOT_FOUND'));

    // User B (Company B) trying to send in Company A
    const res5CrossActor = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Cross-tenant actor attack',
      p_client_command_id: randomUUID(),
      p_actor_user_id: saleUserB,
    });
    assert.ok(res5CrossActor.error, 'Cross-tenant actor must be rejected');
    assert.equal(res5CrossActor.error.code, '42501');
    assert.ok(res5CrossActor.error.message.includes('ACTOR_NOT_AUTHORIZED'));

    // Customer from Company B passed into Company A
    const res5CrossCust = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_customer_id: customerB, // Customer B belongs to Company B
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Cross-tenant customer injection',
      p_client_command_id: randomUUID(),
      p_actor_user_id: saleUserA,
    });
    assert.ok(res5CrossCust.error, 'Cross-tenant customer linkage must fail foreign key isolation');
    console.log('✓ Test 5 passed: Cross-tenant isolation strictly enforced.');

    // --- TEST 6: Scoped Customer Lookup & Safe Fallback ---
    console.log('Executing Test 6: Scoped customer name lookup logic');
    // Verify explicit p_customer_id with valid matching customer
    const cmdExplicitCust = randomUUID();
    const res6Explicit = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_customer_id: customerA,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Explicit customer lookup test',
      p_client_command_id: cmdExplicitCust,
      p_actor_user_id: saleUserA,
    });
    assert.ifError(res6Explicit.error);
    const explicitRows = (await db.query(
      `SELECT metadata FROM public.outbound_deliveries WHERE client_command_id = $1`,
      [cmdExplicitCust]
    )).rows as any[];
    const explicitMeta = typeof explicitRows[0].metadata === 'string' ? JSON.parse(explicitRows[0].metadata) : explicitRows[0].metadata;
    assert.equal(explicitMeta.customer_name, 'Nguyễn Văn A Canonical');

    // Test conversation where customer name in customers table is safely updated
    await db.query(`UPDATE public.customers SET name = 'Nguyễn Văn A Updated' WHERE id = $1`, [customerA]);
    const cmdUpdatedName = randomUUID();
    const res6Updated = await h.client.rpc('record_outbound_interaction_atomic', {
      p_company_id: companyA,
      p_conversation_id: convA,
      p_customer_id: null,
      p_channel: 'FACEBOOK',
      p_sanitized_content: 'Updated name test',
      p_client_command_id: cmdUpdatedName,
      p_actor_user_id: saleUserA,
    });
    assert.ifError(res6Updated.error);
    const updatedRows = (await db.query(
      `SELECT metadata FROM public.outbound_deliveries WHERE client_command_id = $1`,
      [cmdUpdatedName]
    )).rows as any[];
    const updatedMeta = typeof updatedRows[0].metadata === 'string' ? JSON.parse(updatedRows[0].metadata) : updatedRows[0].metadata;
    assert.equal(updatedMeta.customer_name, 'Nguyễn Văn A Updated', 'Reflects latest canonical name in customers table');
    console.log('✓ Test 6 passed: Canonical name lookup dynamically scoped to customers table.');

    console.log('\n========================================');
    console.log('ALL PGLITE SQL REGRESSION CHECKS PASSED!');
    console.log('========================================');
  } finally {
    await h.close();
  }
}

main().catch((err) => {
  console.error('TEST RUN FAILED:', err);
  process.exit(1);
});
