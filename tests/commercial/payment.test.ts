import assert from 'node:assert';
import crypto from 'node:crypto';
import { POST as paymentWebhookHandler } from '../../app/api/webhooks/payment/route';

console.log('================================================================');
console.log('STARTING TV7 PAYMENT WEBHOOK & SIGNATURE UNIT TESTS');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

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

  console.log(`\n================================================================`);
  console.log(`PAYMENT UNIT TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
