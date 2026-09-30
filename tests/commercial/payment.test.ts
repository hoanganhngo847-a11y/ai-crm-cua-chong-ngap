import assert from 'node:assert';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { POST as paymentWebhookHandler } from '../../app/api/webhooks/payment/route';

console.log('================================================================');
console.log('STARTING TV7 PAYMENT WEBHOOK & SIGNATURE UNIT TESTS');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

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

const TEST_SECRET = 'test-webhook-secret-key-12345';
process.env.WEBHOOK_SECRET = TEST_SECRET;

function computeSignature(payload: string, secret: string = TEST_SECRET): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function run() {
  // ----------------------------------------------------------------------------
  // Test 1: Missing signature header returns 401
  // ----------------------------------------------------------------------------
  {
    const req = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: JSON.stringify({ amount: 1000000 }),
      headers: { 'content-type': 'application/json' },
    });

    const res = await paymentWebhookHandler(req);
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert(data.error.includes('Missing signature'));
    testPass('Webhook without signature header rejected with 401');
  }

  // ----------------------------------------------------------------------------
  // Test 2: Invalid signature returns 401
  // ----------------------------------------------------------------------------
  {
    const body = JSON.stringify({ amount: 1000000 });
    const req = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': '0000000000000000000000000000000000000000000000000000000000000000',
      },
    });

    const res = await paymentWebhookHandler(req);
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert(data.error.includes('Invalid signature'));
    testPass('Webhook with invalid HMAC signature rejected with 401');
  }

  // ----------------------------------------------------------------------------
  // Test 3: Malformed JSON returns 400
  // ----------------------------------------------------------------------------
  {
    const malformed = '{ amount: 1000000, unclosed';
    const sig = computeSignature(malformed);
    const req = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: malformed,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': sig,
      },
    });

    const res = await paymentWebhookHandler(req);
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('Malformed JSON'));
    testPass('Webhook with malformed JSON body rejected with 400');
  }

  // ----------------------------------------------------------------------------
  // Test 4: Missing required fields returns 400
  // ----------------------------------------------------------------------------
  {
    const incompletePayload = JSON.stringify({
      provider: 'VIETQR',
      amount: 5000000,
      // missing provider_account, provider_ref, occurred_at
    });
    const sig = computeSignature(incompletePayload);
    const req = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: incompletePayload,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': sig,
      },
    });

    const res = await paymentWebhookHandler(req);
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert(data.error.includes('Missing or invalid required fields'));
    testPass('Webhook with missing required fields rejected with 400');
  }

  // ----------------------------------------------------------------------------
  // Test 5: Missing WEBHOOK_SECRET returns 503
  // ----------------------------------------------------------------------------
  {
    const origSecret = process.env.WEBHOOK_SECRET;
    try {
      delete process.env.WEBHOOK_SECRET;
      const body = JSON.stringify({ provider: 'VIETQR' });
      const req = new Request('http://localhost:3000/api/webhooks/payment', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'x-provider-signature': 'any-sig',
        },
      });

      const res = await paymentWebhookHandler(req);
      assert.strictEqual(res.status, 503);
      const data = await res.json();
      assert.strictEqual(data.error, 'CONFIGURATION_ERROR');
      testPass('Missing server WEBHOOK_SECRET returns 503 fail-closed');
    } finally {
      process.env.WEBHOOK_SECRET = origSecret;
    }
  }

  // ----------------------------------------------------------------------------
  // Test 6: Payment reference extraction regex
  // ----------------------------------------------------------------------------
  {
    const text1 = 'KH Chuyen tien coc DH-9921 cho vach ngan';
    const match1 = text1.match(/DH-[A-Z0-9]+/i);
    assert.strictEqual(match1?.[0].toUpperCase(), 'DH-9921');

    const text2 = 'Nap tien dh-abcde88';
    const match2 = text2.match(/DH-[A-Z0-9]+/i);
    assert.strictEqual(match2?.[0].toUpperCase(), 'DH-ABCDE88');

    const text3 = 'No payment reference in this memo';
    const match3 = text3.match(/DH-[A-Z0-9]+/i);
    assert.strictEqual(match3, null);

    testPass('Payment reference regex extracts canonical order payment reference accurately');
  }

  // ----------------------------------------------------------------------------
  // Test 7: Unknown provider account returns HTTP 422 (Unprocessable Entity)
  // ----------------------------------------------------------------------------
  {
    const body = JSON.stringify({
      provider: 'VIETQR',
      provider_account: `NON_EXISTENT_ACC_${Date.now()}`,
      provider_ref: `tx_unknown_acc_${Date.now()}`,
      amount: 5000000,
      occurred_at: new Date().toISOString(),
      transfer_content: 'DH-UNKNOWN',
    });
    const sig = computeSignature(body);
    const req = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': sig,
      },
    });

    const res = await paymentWebhookHandler(req);
    assert.strictEqual(res.status, 422, 'Unknown provider account must return HTTP 422');
    const data = await res.json();
    assert(data.error.includes('UNKNOWN_PROVIDER_ACCOUNT'));
    testPass('Webhook with unknown provider account returns HTTP 422 (Unprocessable Entity)');
  }

  // ----------------------------------------------------------------------------
  // Test 8: Idempotency payload mismatch returns HTTP 409 (Conflict)
  // ----------------------------------------------------------------------------
  {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321',
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
    );

    const testCompanyId = crypto.randomUUID();
    const testAccount = `ACC_PAYMENT_HTTP_${Date.now()}`;
    const testTxRef = `tx_http_dup_${Date.now()}`;

    await admin.from('companies').insert({ id: testCompanyId, name: 'Payment Route Test Co', status: 'ACTIVE' });
    await admin.from('company_bank_accounts').insert({
      company_id: testCompanyId,
      provider: 'VIETQR',
      provider_account: testAccount,
    });

    // 1st request: valid initial transaction
    const body1 = JSON.stringify({
      provider: 'VIETQR',
      provider_account: testAccount,
      provider_ref: testTxRef,
      amount: 2000000,
      occurred_at: new Date().toISOString(),
      transfer_content: 'DH-TESTMEMO',
    });
    const sig1 = computeSignature(body1);
    const req1 = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: body1,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': sig1,
      },
    });

    const res1 = await paymentWebhookHandler(req1);
    assert.strictEqual(res1.status, 200, 'Initial transaction must return HTTP 200');

    // 2nd request: same provider_ref but changed amount (payload mismatch)
    const body2 = JSON.stringify({
      provider: 'VIETQR',
      provider_account: testAccount,
      provider_ref: testTxRef,
      amount: 9999999, // Changed amount!
      occurred_at: new Date().toISOString(),
      transfer_content: 'DH-TESTMEMO',
    });
    const sig2 = computeSignature(body2);
    const req2 = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: body2,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': sig2,
      },
    });

    const res2 = await paymentWebhookHandler(req2);
    assert.strictEqual(res2.status, 409, 'Reused key with changed payload must return HTTP 409 Conflict');
    const data2 = await res2.json();
    assert(data2.error.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'));
    testPass('Webhook with idempotency payload mismatch returns HTTP 409 (Conflict)');
  }

  // ----------------------------------------------------------------------------
  // Test 9: Cross-company identical provider_ref accepted independently (Section 1)
  // ----------------------------------------------------------------------------
  {
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321',
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
    );

    const companyAId = crypto.randomUUID();
    const companyBId = crypto.randomUUID();
    const accountA = `ACC_A_${Date.now()}`;
    const accountB = `ACC_B_${Date.now()}`;
    const sharedRef = `TX_SHARED_${Date.now()}`;

    await admin.from('companies').insert([
      { id: companyAId, name: 'Cross Company A', status: 'ACTIVE' },
      { id: companyBId, name: 'Cross Company B', status: 'ACTIVE' },
    ]);
    await admin.from('company_bank_accounts').insert([
      { company_id: companyAId, provider: 'VIETQR', provider_account: accountA },
      { company_id: companyBId, provider: 'VIETQR', provider_account: accountB },
    ]);

    // Send for Company A
    const bodyA = JSON.stringify({
      provider: 'VIETQR',
      provider_account: accountA,
      provider_ref: sharedRef,
      amount: 1500000,
      occurred_at: new Date().toISOString(),
      transfer_content: 'DH-MEMOA',
    });
    const reqA = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: bodyA,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': computeSignature(bodyA),
      },
    });
    const resA = await paymentWebhookHandler(reqA);
    assert.strictEqual(resA.status, 200, 'Company A transaction must succeed');

    // Send for Company B with EXACT SAME provider_ref
    const bodyB = JSON.stringify({
      provider: 'VIETQR',
      provider_account: accountB,
      provider_ref: sharedRef,
      amount: 2500000,
      occurred_at: new Date().toISOString(),
      transfer_content: 'DH-MEMOB',
    });
    const reqB = new Request('http://localhost:3000/api/webhooks/payment', {
      method: 'POST',
      body: bodyB,
      headers: {
        'content-type': 'application/json',
        'x-provider-signature': computeSignature(bodyB),
      },
    });
    const resB = await paymentWebhookHandler(reqB);
    assert.strictEqual(resB.status, 200, 'Company B transaction with same provider_ref must succeed independently');

    testPass('Cross-company identical provider_ref accepted independently via HTTP webhook');
  }

  console.log(`\n================================================================`);
  console.log(`PAYMENT UNIT TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
