/**
 * Real Supabase Database Integration Tests for Meta Data Deletion
 *
 * Validates against LIVE local Supabase instance:
 * 1. Security Definer & RLS: anon/authenticated cannot execute trusted RPCs or bypass RLS
 * 2. Unknown confirmation code: han_get_data_deletion_status returns null (no fake status)
 * 3. Tenant Isolation: Deletion request in Company B never touches Company A records
 * 4. Strict Non-Heuristic ASID->PSID: PSID suffix string equality does NOT auto-match;
 *    fails closed into MANUAL_REVIEW_REQUIRED with status RECEIVED, leaving customer intact
 * 5. Authoritative Verified Deletion: explicit verified ASID mapping (metadata->>'asid')
 *    triggers real customer anonymization, contact deletion, identity removal, content scrubbing,
 *    and conversation closure
 * 6. Second Deletion Request: consecutive deletion requests generate distinct records
 *    and independently process new user interactions
 * 7. Idempotent Retry: repeating the same confirmation code returns existing record idempotently
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { cleanupCompanyFixtures, executeRawSql } from '../helpers/fixture-cleanup';

function getPrivateContactsCount(customerId: string): number {
    const raw = executeRawSql(`SELECT count(*) FROM private.customer_private_contacts WHERE customer_id = '${customerId}';`);
    const match = raw.match(/\n\s*(\d+)\s*\n/);
    return match ? parseInt(match[1], 10) : 0;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const TEST_COMPANY_A = 'a0a0a0a0-0001-4000-8000-000000000001';
const TEST_COMPANY_B = 'a0a0a0a0-0002-4000-8000-000000000002';
const TEST_CUSTOMER_A = 'c0c0c0c0-0001-4000-8000-000000000001';
const TEST_CUSTOMER_B = 'c0c0c0c0-0002-4000-8000-000000000002';
const TEST_CONV_A = 'd0d0d0d0-0001-4000-8000-000000000001';
const TEST_CONV_B = 'd0d0d0d0-0002-4000-8000-000000000002';
const TEST_INTERACTION_A = 'e0e0e0e0-0001-4000-8000-000000000001';
const TEST_INTERACTION_B = 'e0e0e0e0-0002-4000-8000-000000000002';

function getServiceClient(): SupabaseClient {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

function getAnonClient(): SupabaseClient {
    return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

async function seedRealDatabase(client: SupabaseClient) {
    cleanupCompanyFixtures([TEST_COMPANY_A, TEST_COMPANY_B]);
    executeRawSql(`DELETE FROM public.meta_data_deletion_requests WHERE company_id IN ('${TEST_COMPANY_A}', '${TEST_COMPANY_B}');`);

    // Upsert Company A
    const { error: cAErr } = await client.from('companies').upsert({
        id: TEST_COMPANY_A,
        name: 'Test Company Alpha',
        status: 'ACTIVE',
    }, { onConflict: 'id' });
    if (cAErr) throw new Error(`Failed to upsert company A: ${cAErr.message}`);

    // Upsert Company B
    const { error: cBErr } = await client.from('companies').upsert({
        id: TEST_COMPANY_B,
        name: 'Test Company Beta',
        status: 'ACTIVE',
    }, { onConflict: 'id' });
    if (cBErr) throw new Error(`Failed to upsert company B: ${cBErr.message}`);

    // Customer A (in Company A)
    const { error: custAErr } = await client.from('customers').insert({
        id: TEST_CUSTOMER_A,
        company_id: TEST_COMPANY_A,
        name: 'Customer Alpha Original Name',
        customer_code: 'CUST-ALPHA-001',
        stage: 'LEAD_NEW',
        source: 'FACEBOOK',
    });
    if (custAErr) throw new Error(`Failed to insert customer A: ${custAErr.message}`);

    // Customer B (in Company B)
    const { error: custBErr } = await client.from('customers').insert({
        id: TEST_CUSTOMER_B,
        company_id: TEST_COMPANY_B,
        name: 'Customer Beta Original Name',
        customer_code: 'CUST-BETA-001',
        stage: 'LEAD_NEW',
        source: 'FACEBOOK',
    });
    if (custBErr) throw new Error(`Failed to insert customer B: ${custBErr.message}`);

    // Private Contacts for A & B (in schema private, seeded via psql)
    executeRawSql(`
        INSERT INTO private.customer_private_contacts (company_id, customer_id, normalized_phone, raw_phone, phone_country_code, is_verified)
        VALUES
          ('${TEST_COMPANY_A}', '${TEST_CUSTOMER_A}', '+84912345678', '0912345678', 'VN', true),
          ('${TEST_COMPANY_B}', '${TEST_CUSTOMER_B}', '+84987654321', '0987654321', 'VN', true)
        ON CONFLICT (customer_id) DO UPDATE SET
          normalized_phone = EXCLUDED.normalized_phone,
          raw_phone = EXCLUDED.raw_phone;
    `);

    // Identity for A: ordinary Facebook Messenger identity (external_id = '<page_id>:<psid>')
    const { error: idAErr } = await client.from('identities').insert({
        company_id: TEST_COMPANY_A,
        customer_id: TEST_CUSTOMER_A,
        channel: 'FACEBOOK',
        external_id: '1026991374010112:psid_user_99999',
        metadata: {},
    });
    if (idAErr) throw new Error(`Failed to insert identity A: ${idAErr.message}`);

    // Identity for B
    const { error: idBErr } = await client.from('identities').insert({
        company_id: TEST_COMPANY_B,
        customer_id: TEST_CUSTOMER_B,
        channel: 'FACEBOOK',
        external_id: '1026991374010112:psid_user_88888',
        metadata: {},
    });
    if (idBErr) throw new Error(`Failed to insert identity B: ${idBErr.message}`);

    // Conversation A
    const { error: convAErr } = await client.from('conversations').insert({
        id: TEST_CONV_A,
        company_id: TEST_COMPANY_A,
        customer_id: TEST_CUSTOMER_A,
        channel: 'FACEBOOK',
        external_conversation_id: 'fb-conv-alpha-001',
        status: 'OPEN',
        unread_count: 1,
    });
    if (convAErr) throw new Error(`Failed to insert conversation A: ${convAErr.message}`);

    // Conversation B
    const { error: convBErr } = await client.from('conversations').insert({
        id: TEST_CONV_B,
        company_id: TEST_COMPANY_B,
        customer_id: TEST_CUSTOMER_B,
        channel: 'FACEBOOK',
        external_conversation_id: 'fb-conv-beta-001',
        status: 'OPEN',
        unread_count: 1,
    });
    if (convBErr) throw new Error(`Failed to insert conversation B: ${convBErr.message}`);

    // Interaction A
    const { error: intAErr } = await client.from('interactions').insert({
        id: TEST_INTERACTION_A,
        company_id: TEST_COMPANY_A,
        customer_id: TEST_CUSTOMER_A,
        conversation_id: TEST_CONV_A,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        actor_type: 'CUSTOMER',
        direction: 'INBOUND',
        sanitized_content: 'Chào công ty, tôi muốn hỏi về dịch vụ',
        sanitization_status: 'SUCCEEDED',
    });
    if (intAErr) throw new Error(`Failed to insert interaction A: ${intAErr.message}`);

    // Interaction B
    const { error: intBErr } = await client.from('interactions').insert({
        id: TEST_INTERACTION_B,
        company_id: TEST_COMPANY_B,
        customer_id: TEST_CUSTOMER_B,
        conversation_id: TEST_CONV_B,
        channel: 'FACEBOOK',
        type: 'MESSAGE',
        actor_type: 'CUSTOMER',
        direction: 'INBOUND',
        sanitized_content: 'Tin nhắn công ty B',
        sanitization_status: 'SUCCEEDED',
    });
    if (intBErr) throw new Error(`Failed to insert interaction B: ${intBErr.message}`);
}

test('REAL DB Suite: Meta Data Deletion Persistence & Security', async (t) => {
    const admin = getServiceClient();
    const anon = getAnonClient();

    await seedRealDatabase(admin);

    try {
        await t.test('1. Security Definer: anon/authenticated role cannot execute trusted deletion RPCs', async () => {
            // Anon cannot record deletion requests
            const { error: recErr } = await anon.rpc('han_record_data_deletion_request', {
                p_company: TEST_COMPANY_A,
                p_meta_user_id: 'attacker_user_id',
                p_confirmation_code: 'del_anon_forbidden_1',
                p_raw: {},
            });
            assert.ok(recErr, 'Anon execution of han_record_data_deletion_request must fail');

            // Anon cannot query status via privileged RPC
            const { error: statErr } = await anon.rpc('han_get_data_deletion_status', {
                p_confirmation_code: 'del_anon_forbidden_1',
            });
            assert.ok(statErr, 'Anon execution of han_get_data_deletion_status must fail');

            // Anon cannot read meta_data_deletion_requests directly through RLS
            const { data: anonData } = await anon.from('meta_data_deletion_requests').select('*');
            assert.equal(anonData?.length || 0, 0, 'RLS must block anon from reading deletion requests');
        });

        await t.test('2. Unknown confirmation code: han_get_data_deletion_status returns null (no fake status)', async () => {
            const { data, error } = await admin.rpc('han_get_data_deletion_status', {
                p_confirmation_code: 'del_00000000000000000000000000000000',
            });
            assert.equal(error, null);
            assert.equal(data, null, 'Unknown confirmation code must return null');
        });

        await t.test('3. Tenant Isolation: Deletion request in Company B never touches Company A', async () => {
            // Call deletion on Company B with an unmapped user
            const { data: bRes, error: bErr } = await admin.rpc('han_record_data_deletion_request', {
                p_company: TEST_COMPANY_B,
                p_meta_user_id: 'random_meta_user_b',
                p_confirmation_code: 'del_0000000000000000000000000000000b',
                p_raw: { source: 'unit_test' },
            });
            assert.equal(bErr, null);
            assert.equal(bRes.status, 'RECEIVED');

            // Verify Company A customer and private contacts remain 100% untouched
            const { data: custA } = await admin.from('customers').select('*').eq('id', TEST_CUSTOMER_A).single();
            assert.equal(custA.name, 'Customer Alpha Original Name', 'Customer A name untouched');
            assert.equal(custA.stage, 'LEAD_NEW', 'Customer A stage untouched');

            const cpcACount = getPrivateContactsCount(TEST_CUSTOMER_A);
            assert.equal(cpcACount, 1, 'Customer A private contact untouched');
        });

        await t.test('4. Strict Non-Heuristic ASID->PSID: String equality on PSID does NOT auto-match or delete', async () => {
            // In CRM, Customer Alpha has identity external_id = '1026991374010112:psid_user_99999'.
            // Meta sends deletion callback for ASID = 'psid_user_99999'.
            // Because ASID != PSID and no authoritative mapping exists, system MUST NOT auto-match!
            const { data: heuristicRes, error: heuristicErr } = await admin.rpc('han_record_data_deletion_request', {
                p_company: TEST_COMPANY_A,
                p_meta_user_id: 'psid_user_99999',
                p_confirmation_code: 'del_00000000000000000000000000000002',
                p_raw: { user_id: 'psid_user_99999' },
            });
            assert.equal(heuristicErr, null);
            assert.equal(heuristicRes.status, 'RECEIVED', 'Must fail closed to RECEIVED status');
            assert.equal(heuristicRes.resolution_strategy, 'MANUAL_REVIEW_REQUIRED', 'Must queue for MANUAL_REVIEW_REQUIRED');
            assert.equal(heuristicRes.customer_id, null, 'Must NOT assign or delete customer');

            // Verify Customer Alpha is NOT deleted or anonymized!
            const { data: custA } = await admin.from('customers').select('*').eq('id', TEST_CUSTOMER_A).single();
            assert.equal(custA.name, 'Customer Alpha Original Name', 'Customer Alpha name must NOT be altered');
            assert.equal(custA.stage, 'LEAD_NEW', 'Customer Alpha stage must remain LEAD_NEW');

            // Verify private contacts NOT deleted
            const cpcAHeuristicCount = getPrivateContactsCount(TEST_CUSTOMER_A);
            assert.equal(cpcAHeuristicCount, 1, 'Customer Alpha private contacts must NOT be deleted');

            // Verify identity NOT deleted
            const { data: idA } = await admin.from('identities').select('*').eq('customer_id', TEST_CUSTOMER_A);
            assert.equal(idA?.length, 1, 'Customer Alpha identity must NOT be deleted');

            // Verify interaction content NOT scrubbed
            const { data: intA } = await admin.from('interactions').select('*').eq('id', TEST_INTERACTION_A).single();
            assert.equal(intA.sanitized_content, 'Chào công ty, tôi muốn hỏi về dịch vụ');

            // Verify conversation NOT closed
            const { data: convA } = await admin.from('conversations').select('*').eq('id', TEST_CONV_A).single();
            assert.equal(convA.status, 'OPEN');
        });

        await t.test('5. Authoritative Verified Deletion: explicit verified ASID mapping anonymizes CRM records', async () => {
            // Add authoritative ASID mapping to Customer Alpha's identity: metadata = { asid: 'verified_asid_77777777' }
            const { error: updateErr } = await admin.from('identities')
                .update({ metadata: { asid: 'verified_asid_77777777' } })
                .eq('customer_id', TEST_CUSTOMER_A)
                .eq('company_id', TEST_COMPANY_A);
            assert.equal(updateErr, null);

            // Call deletion with the authoritative verified ASID
            const { data: authRes, error: authErr } = await admin.rpc('han_record_data_deletion_request', {
                p_company: TEST_COMPANY_A,
                p_meta_user_id: 'verified_asid_77777777',
                p_confirmation_code: 'del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                p_raw: { user_id: 'verified_asid_77777777' },
            });
            assert.equal(authErr, null);
            assert.equal(authRes.status, 'COMPLETED', 'Must complete deletion for authoritative match');
            assert.equal(authRes.resolution_strategy, 'AUTO_MATCHED');
            assert.equal(authRes.customer_id, TEST_CUSTOMER_A);

            // Verify real anonymization of Customer Alpha in DB
            const { data: custA } = await admin.from('customers').select('*').eq('id', TEST_CUSTOMER_A).single();
            assert.equal(custA.name, 'Khách hàng đã xóa dữ liệu (Meta Data Deletion)');
            assert.equal(custA.stage, 'LOST');

            // Verify private contacts deleted
            const cpcAAuthCount = getPrivateContactsCount(TEST_CUSTOMER_A);
            assert.equal(cpcAAuthCount, 0, 'Customer private contacts must be deleted');

            // Verify Facebook identities deleted
            const { data: idA } = await admin.from('identities').select('*').eq('customer_id', TEST_CUSTOMER_A);
            assert.equal(idA?.length || 0, 0, 'Facebook identity must be deleted');

            // Verify conversation closed
            const { data: convA } = await admin.from('conversations').select('*').eq('id', TEST_CONV_A).single();
            assert.equal(convA.status, 'CLOSED');

            // Verify interaction content scrubbed
            const { data: intA } = await admin.from('interactions').select('*').eq('id', TEST_INTERACTION_A).single();
            assert.equal(intA.sanitized_content, '[Dữ liệu cá nhân đã xóa theo yêu cầu Data Deletion của người dùng]');
        });

        await t.test('6. Second Deletion Request: consecutive deletion requests generate distinct requests', async () => {
            // Customer Alpha had deletion request 1: del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
            // Now user initiates deletion request 2 with a new confirmation code
            const { data: req2Res, error: req2Err } = await admin.rpc('han_record_data_deletion_request', {
                p_company: TEST_COMPANY_A,
                p_meta_user_id: 'verified_asid_77777777',
                p_confirmation_code: 'del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                p_raw: { user_id: 'verified_asid_77777777', attempt: 2 },
            });
            assert.equal(req2Err, null);
            assert.equal(req2Res.confirmation_code, 'del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

            // Status lookup for request 1 returns request 1
            const { data: stat1 } = await admin.rpc('han_get_data_deletion_status', {
                p_confirmation_code: 'del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            });
            assert.equal(stat1.confirmation_code, 'del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            assert.equal(stat1.status, 'COMPLETED');

            // Status lookup for request 2 returns request 2
            const { data: stat2 } = await admin.rpc('han_get_data_deletion_status', {
                p_confirmation_code: 'del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            });
            assert.equal(stat2.confirmation_code, 'del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
            assert.notEqual(stat1.confirmation_code, stat2.confirmation_code);
        });

        await t.test('7. Idempotent Retry: repeating the same confirmation code returns existing record', async () => {
            const { data: retryRes, error: retryErr } = await admin.rpc('han_record_data_deletion_request', {
                p_company: TEST_COMPANY_A,
                p_meta_user_id: 'verified_asid_77777777',
                p_confirmation_code: 'del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                p_raw: { retry: true },
            });
            assert.equal(retryErr, null);
            assert.equal(retryRes.confirmation_code, 'del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            assert.equal(retryRes.status, 'COMPLETED');
        });

    } finally {
        cleanupCompanyFixtures([TEST_COMPANY_A, TEST_COMPANY_B]);
    }
});
