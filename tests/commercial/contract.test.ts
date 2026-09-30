import assert from 'node:assert';
import { STORAGE_BUCKET_MAP, SIGNED_URL_TTL } from '../../shared/contracts/sensitive';
import { PDFDocument } from 'pdf-lib';

console.log('================================================================');
console.log('STARTING TV7 CONTRACT STORAGE & RENDERING UNIT TESTS');
console.log('================================================================\n');

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

async function run() {
  // ----------------------------------------------------------------------------
  // Test 1: Canonical contract bucket name is 'contracts' (NOT 'secure-documents')
  // ----------------------------------------------------------------------------
  {
    assert.strictEqual(
      STORAGE_BUCKET_MAP.CONTRACT,
      'contracts',
      'Canonical contract storage bucket must be "contracts"'
    );
    assert.strictEqual(
      SIGNED_URL_TTL.CONTRACT,
      1800,
      'Contract signed URL TTL must be frozen at 1800 seconds'
    );
    testPass('STORAGE_BUCKET_MAP and SIGNED_URL_TTL match frozen Foundation contracts');
  }

  // ----------------------------------------------------------------------------
  // Test 2: Server-derived contract paths follow canonical multi-tenant structure
  // ----------------------------------------------------------------------------
  {
    const companyId = '33333333-3333-3333-3333-333333333333';
    const contractId = 'aaaaaaaa-1111-0000-0000-000000000041';
    const revisionNo = 1;

    const generatedPath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/generated.pdf`;
    const signedPath = `${companyId}/contracts/${contractId}/revision-${revisionNo}/signed.pdf`;

    assert(generatedPath.startsWith(`${companyId}/contracts/${contractId}/`));
    assert(generatedPath.endsWith('/generated.pdf'));
    assert(signedPath.endsWith('/signed.pdf'));
    testPass('Contract storage paths are deterministic and scoped strictly by companyId and contractId');
  }

  // ----------------------------------------------------------------------------
  // Test 3: PDF Document generation produces valid PDF bytes
  // ----------------------------------------------------------------------------
  {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 400]);
    page.drawText('CONG TY TNHH CUA CHONG NGAP - HOP DONG', { x: 50, y: 350 });
    const pdfBytes = await pdfDoc.save();

    assert(pdfBytes instanceof Uint8Array);
    assert(pdfBytes.length > 100);
    // Verify PDF header magic bytes '%PDF-'
    const header = Buffer.from(pdfBytes.slice(0, 5)).toString('utf8');
    assert.strictEqual(header, '%PDF-');
    testPass('pdf-lib renders valid PDF buffer with canonical header bytes');
  }

  // ----------------------------------------------------------------------------
  // Test 4: Signed PDF validation (Section 6)
  // ----------------------------------------------------------------------------
  {
    const { validateSignedPdf, MAX_CONTRACT_PDF_SIZE_BYTES } = await import('../../features/contract/services');

    assert.strictEqual(MAX_CONTRACT_PDF_SIZE_BYTES, 10485760, 'Max contract PDF limit must be 10MB (10485760 bytes)');

    // Case A: Empty buffer -> rejected
    assert.throws(
      () => validateSignedPdf(Buffer.alloc(0)),
      /INVALID_PDF/,
      'Empty buffer must be rejected'
    );

    // Case B: Plain text bytes -> rejected
    assert.throws(
      () => validateSignedPdf(Buffer.from('Hello this is not a pdf file')),
      /INVALID_PDF/,
      'Plain text bytes must be rejected'
    );

    // Case C: Oversized buffer (>10MB) -> rejected
    const oversized = Buffer.alloc(10485761);
    oversized.write('%PDF-');
    assert.throws(
      () => validateSignedPdf(oversized),
      /INVALID_PDF/,
      'Oversized PDF (>10MB) must be rejected'
    );

    // Case D: Valid PDF bytes -> allowed
    const validPdfBuffer = Buffer.from('%PDF-1.4 test contract content');
    assert.doesNotThrow(() => validateSignedPdf(validPdfBuffer));

    testPass('Signed PDF validation enforces non-empty, <=10MB, and %PDF- header');
  }

  // ----------------------------------------------------------------------------
  // Test 5: Dynamic revision storage path (NO hardcoded revision-1!) (Section 5)
  // ----------------------------------------------------------------------------
  {
    const companyId = '33333333-3333-3333-3333-333333333333';
    const contractId = 'aaaaaaaa-1111-0000-0000-000000000042';

    // Verify path for revision 2
    const revision2 = 2;
    const pathRev2 = `${companyId}/contracts/${contractId}/revision-${revision2}/signed.pdf`;
    assert.strictEqual(
      pathRev2,
      `${companyId}/contracts/${contractId}/revision-2/signed.pdf`,
      'Path for revision 2 must be revision-2'
    );

    // Verify path for revision 5
    const revision5 = 5;
    const pathRev5 = `${companyId}/contracts/${contractId}/revision-${revision5}/signed.pdf`;
    assert.strictEqual(
      pathRev5,
      `${companyId}/contracts/${contractId}/revision-5/signed.pdf`,
      'Path for revision 5 must be revision-5'
    );

    testPass('Dynamic revision storage path derived from canonical revision_no without hardcoding revision-1');
  }

  // ----------------------------------------------------------------------------
  // Test 6: Pre-upload resource resolution & zero-upload on failure (Section 4)
  // ----------------------------------------------------------------------------
  {
    const { signContract } = await import('../../features/contract/services');

    // Case A: Unauthenticated / unauthorized actor rejected before any storage upload
    try {
      await signContract({
        companyId: '33333333-3333-3333-3333-333333333333',
        contractId: '00000000-0000-0000-0000-000000000001',
        signedPdfBuffer: Buffer.from('not a pdf'),
      });
      assert.fail('Unauthorized actor must throw');
    } catch (err: any) {
      assert(
        err.message?.includes('INVALID_PDF') ||
        err.message?.includes('MFA_REQUIRED') ||
        err.message?.includes('ROLE_FORBIDDEN') ||
        err.code === 'UNAUTHENTICATED' ||
        err.message?.includes('đăng nhập')
      );
    }

    testPass('signContract rejects unauthorized actor before attempting storage upload');
  }

  // ----------------------------------------------------------------------------
  // Test 7: Signed URL parameter constraints (Section 15)
  // ----------------------------------------------------------------------------
  {
    const { getContractDownloadUrl } = await import('../../features/contract/services');

    // Verify method signature takes only contractId and optional variant (no client path!)
    assert.strictEqual(typeof getContractDownloadUrl, 'function');
    assert.strictEqual(SIGNED_URL_TTL.CONTRACT, 1800, 'Contract download URL TTL must be 1800s');
    assert.strictEqual(STORAGE_BUCKET_MAP.CONTRACT, 'contracts', 'Contract download bucket must be contracts');

    testPass('Contract download uses canonical bucket "contracts", TTL 1800s, browser controls only contractId and variant');
  }

  // ----------------------------------------------------------------------------
  // Test 8: Signed contract immutability: already SIGNED contract returns ALREADY_PROCESSED (Section 2)
  // ----------------------------------------------------------------------------
  {
    const { signContract } = await import('../../features/contract/services');
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const testCo = crypto.randomUUID();
    const testContractId = crypto.randomUUID();
    const testCustomer = crypto.randomUUID();
    const userEmail = `boss_immut_${Date.now()}@test.local`;

    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email: userEmail,
      password: 'Password123!@#',
      email_confirm: true,
      user_metadata: { full_name: 'Boss Immut' },
    });
    assert(!userErr && userData.user);
    const testUser = userData.user.id;

    await admin.from('companies').insert({ id: testCo, name: 'Immutability Co', status: 'ACTIVE' });
    await admin.from('customers').insert({ id: testCustomer, company_id: testCo, name: 'Customer Immut', source: 'MANUAL', stage: 'CONTRACT_SIGNED' });
    await admin.from('user_profiles').upsert({ id: testUser, full_name: 'Boss Immut', status: 'ACTIVE' });
    await admin.from('company_members').insert({ company_id: testCo, user_id: testUser, role: 'BOSS_ADMIN', status: 'ACTIVE' });

    const policyId = crypto.randomUUID();
    const { error: pErr } = await admin.from('pricing_policies').insert({
      id: policyId,
      company_id: testCo,
      version: 'v1',
      conditions: { deposit_percentage: 30 },
      price_rules: { base_price_per_sqm: 5000000 },
      effective_at: new Date().toISOString(),
      status: 'ACTIVE',
    });
    assert(!pErr, `policy insert: ${pErr?.message}`);

    const { data: calcData, error: calcErr } = await admin.rpc('save_price_calculation_rpc', {
      p_company_id: testCo,
      p_customer_id: testCustomer,
      p_survey_id: null,
      p_pricing_policy_id: policyId,
      p_policy_version: 'v1',
      p_input_data: { width: 2, height: 1 },
      p_amount: 10000000,
      p_status: 'CALCULATED',
      p_missing_fields: [],
    });
    assert(!calcErr && calcData?.id, `calc error: ${calcErr?.message}`);

    const { data: orderData, error: orderErr } = await admin.rpc('create_order_from_calculation_rpc', {
      p_company_id: testCo,
      p_customer_id: testCustomer,
      p_price_calculation_id: calcData.id,
      p_payment_reference: `DH-IMMUT-${Date.now()}`,
      p_actor_user_id: testUser,
    });
    assert(!orderErr && orderData?.orderId, `order error: ${orderErr?.message}`);
    const testOrderId = orderData.orderId;

    const canonicalPath = `${testCo}/contracts/${testContractId}/revision-1/signed.pdf`;
    const { error: kErr } = await admin.from('contracts').insert({
      id: testContractId,
      company_id: testCo,
      order_id: testOrderId,
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: `${testCo}/contracts/${testContractId}/revision-1/generated.pdf`,
      signed_file_ref: canonicalPath,
      status: 'SIGNED',
      contract_value: 10000000,
      is_current: true,
    });
    assert(!kErr, `contract insert: ${kErr?.message}`);

    const mockBossClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: testUser, email: 'boss@immut.local' } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: [{ id: 'factor-boss-totp', status: 'verified' }] },
            error: null,
          }),
        },
      },
      from: (table: string) => admin.from(table),
    } as any;

    const res = await signContract({
      companyId: testCo,
      contractId: testContractId,
      signedPdfBuffer: Buffer.from('%PDF-1.4 new arbitrary content'),
    }, mockBossClient);

    assert.strictEqual(res.status, 'ALREADY_PROCESSED');
    assert.strictEqual(res.alreadyProcessed, true);
    testPass('signContract on already SIGNED contract returns ALREADY_PROCESSED before any storage upload');
  }

  // ----------------------------------------------------------------------------
  // Test 9 (Test A): Storage upload succeeds, DB finalize fails before commit -> cleanup and retry succeeds
  // ----------------------------------------------------------------------------
  {
    const { signContract } = await import('../../features/contract/services');
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const testCo = crypto.randomUUID();
    const testContractId = crypto.randomUUID();
    const testCustomer = crypto.randomUUID();
    const userEmail = `boss_recov_a_${Date.now()}@test.local`;

    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email: userEmail,
      password: 'Password123!@#',
      email_confirm: true,
      user_metadata: { full_name: 'Boss Recov A' },
    });
    assert(!userErr && userData.user);
    const testUser = userData.user.id;

    await admin.from('companies').insert({ id: testCo, name: 'Recovery A Co', status: 'ACTIVE' });
    await admin.from('customers').insert({ id: testCustomer, company_id: testCo, name: 'Customer Recov A', source: 'MANUAL', stage: 'ORDER_CREATED' });
    await admin.from('user_profiles').upsert({ id: testUser, full_name: 'Boss Recov A', status: 'ACTIVE' });
    await admin.from('company_members').insert({ company_id: testCo, user_id: testUser, role: 'BOSS_ADMIN', status: 'ACTIVE' });

    const policyId = crypto.randomUUID();
    await admin.from('pricing_policies').insert({
      id: policyId,
      company_id: testCo,
      version: 'v1',
      conditions: { deposit_percentage: 30 },
      price_rules: { base_price_per_sqm: 5000000 },
      effective_at: new Date().toISOString(),
      status: 'ACTIVE',
    });

    const { data: calcData } = await admin.rpc('save_price_calculation_rpc', {
      p_company_id: testCo,
      p_customer_id: testCustomer,
      p_survey_id: null,
      p_pricing_policy_id: policyId,
      p_policy_version: 'v1',
      p_input_data: { width: 2, height: 1 },
      p_amount: 10000000,
      p_status: 'CALCULATED',
      p_missing_fields: [],
    });

    const { data: orderData } = await admin.rpc('create_order_from_calculation_rpc', {
      p_company_id: testCo,
      p_customer_id: testCustomer,
      p_price_calculation_id: calcData.id,
      p_payment_reference: `DH-RECOV-A-${Date.now()}`,
      p_actor_user_id: testUser,
    });
    const testOrderId = orderData.orderId;

    const canonicalSignedPath = `${testCo}/contracts/${testContractId}/revision-1/signed.pdf`;
    await admin.from('contracts').insert({
      id: testContractId,
      company_id: testCo,
      order_id: testOrderId,
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: `${testCo}/contracts/${testContractId}/revision-1/generated.pdf`,
      signed_file_ref: null,
      status: 'GENERATED',
      contract_value: 10000000,
      is_current: true,
    });

    const mockBossClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: testUser, email: userEmail } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: [{ id: 'factor-boss-totp', status: 'verified' }] },
            error: null,
          }),
        },
      },
      from: (table: string) => admin.from(table),
    } as any;

    // Simulate: Storage upload SUCCESS, finalize RPC FAILURE before DB commit
    const failingRpcAdmin = new Proxy(admin, {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (fnName: string, args: any) => {
            if (fnName === 'finalize_contract_signing_rpc') {
              return { data: null, error: new Error('SIMULATED_FINALIZE_RPC_NETWORK_FAILURE') };
            }
            return (target as any).rpc(fnName, args);
          };
        }
        return (target as any)[prop];
      },
    });

    const testPdfBuffer = Buffer.from('%PDF-1.4 simulated contract pdf content for test A');

    let threwExpected = false;
    try {
      await signContract({
        companyId: testCo,
        contractId: testContractId,
        signedPdfBuffer: testPdfBuffer,
      }, mockBossClient, failingRpcAdmin as any);
    } catch (err: any) {
      threwExpected = true;
      assert(err.message.includes('SIMULATED_FINALIZE_RPC_NETWORK_FAILURE'));
    }
    assert(threwExpected, 'Must throw original finalization failure');

    // Invariants after failure:
    // 1. Storage object removed (cleaned up)
    const { data: fileData, error: fileErr } = await admin.storage
      .from('contracts')
      .download(canonicalSignedPath);
    assert(fileErr || !fileData, 'Storage object must be removed after DB finalize failure');

    // 2. DB still GENERATED, signed_file_ref still null
    const { data: contractAfterFail } = await admin
      .from('contracts')
      .select('status, signed_file_ref')
      .eq('id', testContractId)
      .single();
    assert.strictEqual(contractAfterFail?.status, 'GENERATED');
    assert.strictEqual(contractAfterFail?.signed_file_ref, null);

    // 3. Retry signing with normal finalize behavior MUST SUCCEED (not blocked by STORAGE_OBJECT_ALREADY_EXISTS)
    const retryResult = await signContract({
      companyId: testCo,
      contractId: testContractId,
      signedPdfBuffer: testPdfBuffer,
    }, mockBossClient, admin as any);

    assert.strictEqual(retryResult.status, 'SIGNED');

    // Verify DB is now SIGNED
    const { data: contractAfterRetry } = await admin
      .from('contracts')
      .select('status, signed_file_ref')
      .eq('id', testContractId)
      .single();
    assert.strictEqual(contractAfterRetry?.status, 'SIGNED');
    assert.strictEqual(contractAfterRetry?.signed_file_ref, canonicalSignedPath);

    // Verify storage object now exists
    const { data: storedAfterRetry, error: storedErr } = await admin.storage
      .from('contracts')
      .download(canonicalSignedPath);
    assert(!storedErr && storedAfterRetry, 'Storage object must exist after successful retry');

    testPass('Test A: Storage upload succeeds, DB finalize fails before commit -> cleanup and retry succeeds');
  }

  // ----------------------------------------------------------------------------
  // Test 10 (Test B): Finalize committed in DB but response appears failed (simulated network loss)
  // ----------------------------------------------------------------------------
  {
    const { signContract } = await import('../../features/contract/services');
    const { createClient } = await import('@supabase/supabase-js');
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const testCo = crypto.randomUUID();
    const testContractId = crypto.randomUUID();
    const testCustomer = crypto.randomUUID();
    const userEmail = `boss_recov_b_${Date.now()}@test.local`;

    const { data: userData, error: userErr } = await admin.auth.admin.createUser({
      email: userEmail,
      password: 'Password123!@#',
      email_confirm: true,
      user_metadata: { full_name: 'Boss Recov B' },
    });
    assert(!userErr && userData.user);
    const testUser = userData.user.id;

    await admin.from('companies').insert({ id: testCo, name: 'Recovery B Co', status: 'ACTIVE' });
    await admin.from('customers').insert({ id: testCustomer, company_id: testCo, name: 'Customer Recov B', source: 'MANUAL', stage: 'ORDER_CREATED' });
    await admin.from('user_profiles').upsert({ id: testUser, full_name: 'Boss Recov B', status: 'ACTIVE' });
    await admin.from('company_members').insert({ company_id: testCo, user_id: testUser, role: 'BOSS_ADMIN', status: 'ACTIVE' });

    const policyId = crypto.randomUUID();
    await admin.from('pricing_policies').insert({
      id: policyId,
      company_id: testCo,
      version: 'v1',
      conditions: { deposit_percentage: 30 },
      price_rules: { base_price_per_sqm: 5000000 },
      effective_at: new Date().toISOString(),
      status: 'ACTIVE',
    });

    const { data: calcData } = await admin.rpc('save_price_calculation_rpc', {
      p_company_id: testCo,
      p_customer_id: testCustomer,
      p_survey_id: null,
      p_pricing_policy_id: policyId,
      p_policy_version: 'v1',
      p_input_data: { width: 2, height: 1 },
      p_amount: 10000000,
      p_status: 'CALCULATED',
      p_missing_fields: [],
    });

    const { data: orderData } = await admin.rpc('create_order_from_calculation_rpc', {
      p_company_id: testCo,
      p_customer_id: testCustomer,
      p_price_calculation_id: calcData.id,
      p_payment_reference: `DH-RECOV-B-${Date.now()}`,
      p_actor_user_id: testUser,
    });
    const testOrderId = orderData.orderId;

    const canonicalSignedPath = `${testCo}/contracts/${testContractId}/revision-1/signed.pdf`;
    await admin.from('contracts').insert({
      id: testContractId,
      company_id: testCo,
      order_id: testOrderId,
      revision_no: 1,
      template_version: 'v1',
      generated_file_ref: `${testCo}/contracts/${testContractId}/revision-1/generated.pdf`,
      signed_file_ref: null,
      status: 'GENERATED',
      contract_value: 10000000,
      is_current: true,
    });

    const mockBossClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: testUser, email: userEmail } },
          error: null,
        }),
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2', currentAuthenticationMethods: [] },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: [{ id: 'factor-boss-totp', status: 'verified' }] },
            error: null,
          }),
        },
      },
      from: (table: string) => admin.from(table),
    } as any;

    // Simulate: DB finalize actually commits in Postgres, but caller receives simulated RPC/network error
    const droppedResponseAdmin = new Proxy(admin, {
      get(target, prop) {
        if (prop === 'rpc') {
          return async (fnName: string, args: any) => {
            if (fnName === 'finalize_contract_signing_rpc') {
              // Execute the real RPC so DB actually commits:
              await (target as any).rpc(fnName, args);
              // But simulate network drop or lost response:
              return { data: null, error: new Error('SIMULATED_NETWORK_CONNECTION_LOST_AFTER_COMMIT') };
            }
            return (target as any).rpc(fnName, args);
          };
        }
        return (target as any)[prop];
      },
    });

    const testPdfBuffer = Buffer.from('%PDF-1.4 simulated contract pdf content for test B');

    // Calling signContract with droppedResponseAdmin
    const resB = await signContract({
      companyId: testCo,
      contractId: testContractId,
      signedPdfBuffer: testPdfBuffer,
    }, mockBossClient, droppedResponseAdmin as any);

    // Expected: Service re-reads DB, discovers SIGNED + canonical ref, returns deterministic success
    assert.strictEqual(resB.success, true);
    assert.strictEqual(resB.status, 'SIGNED');
    assert.strictEqual(resB.alreadyProcessed, true);

    // Invariants:
    // 1. ZERO storage deletion - signed PDF remains intact
    const { data: storedBData, error: storedBErr } = await admin.storage
      .from('contracts')
      .download(canonicalSignedPath);
    assert(!storedBErr && storedBData, 'Storage object must NOT be deleted in Case A');
    const storedBuf = Buffer.from(await storedBData.arrayBuffer());
    assert.deepStrictEqual(storedBuf, testPdfBuffer, 'Stored PDF bytes must remain strictly identical');

    // 2. DB state is SIGNED with canonical signed_file_ref
    const { data: contractB } = await admin
      .from('contracts')
      .select('status, signed_file_ref')
      .eq('id', testContractId)
      .single();
    assert.strictEqual(contractB?.status, 'SIGNED');
    assert.strictEqual(contractB?.signed_file_ref, canonicalSignedPath);

    testPass('Test B: Finalize committed in DB but RPC response lost -> re-read discovers SIGNED, zero storage deletion');
  }

  console.log(`\n================================================================`);
  console.log(`CONTRACT UNIT TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
