import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decryptGeminiApiKey,
  encryptGeminiApiKey,
  runWithGeminiKeyPool,
} from '../../features/gemini-key-pool/service';

let passed = 0;
function pass(name: string) {
  passed += 1;
  console.log(`[PASS] ${name}`);
}

function makeClient(keys: Array<{ id: string; apiKey: string }>) {
  const encrypted = keys.map((item) => {
    const value = encryptGeminiApiKey(item.apiKey);
    return {
      key_id: item.id,
      ciphertext: value.ciphertext,
      iv: value.iv,
      auth_tag: value.authTag,
    };
  });
  const marks: Array<{ keyId: string; result: string; code: string | null }> = [];
  let claimIndex = 0;

  const client = {
    from(table: string) {
      assert.equal(table, 'gemini_api_key_pool');
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({ count: keys.length, error: null });
            },
          };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'gemini_pool_claim_key') {
        const excluded = (args.p_exclude as string[]) || [];
        while (claimIndex < encrypted.length && excluded.includes(encrypted[claimIndex].key_id)) {
          claimIndex += 1;
        }
        const row = encrypted[claimIndex];
        claimIndex += 1;
        return { data: row ? [row] : [], error: null };
      }
      if (name === 'gemini_pool_mark_result') {
        marks.push({
          keyId: String(args.p_key_id),
          result: String(args.p_result),
          code: args.p_error_code == null ? null : String(args.p_error_code),
        });
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  } as unknown as SupabaseClient;

  return { client, marks };
}

async function main() {
  const originalEnabled = process.env.GEMINI_POOL_ENABLED;
  const originalMaster = process.env.GEMINI_POOL_MASTER_KEY_B64;
  process.env.GEMINI_POOL_MASTER_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

  try {
    const encrypted = encryptGeminiApiKey('test-key-abcdefghijklmnopqrstuvwxyz');
    const decrypted = decryptGeminiApiKey({
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
    });
    assert.equal(decrypted, 'test-key-abcdefghijklmnopqrstuvwxyz');
    assert.equal(encrypted.fingerprint.length, 64);
    pass('AES-GCM encryption/decryption round trip');

    process.env.GEMINI_POOL_ENABLED = 'false';
    const fallbackSeen: string[] = [];
    const fallbackResult = await runWithGeminiKeyPool({
      fallbackKey: 'fallback-key-abcdefghijklmnopqrstuvwxyz',
      rateLimitCode: 'GEMINI_RATE_LIMITED',
      authErrorCode: 'GEMINI_AUTH_ERROR',
      invoke: async (key) => {
        fallbackSeen.push(key);
        return 'ok';
      },
    });
    assert.equal(fallbackResult, 'ok');
    assert.deepEqual(fallbackSeen, ['fallback-key-abcdefghijklmnopqrstuvwxyz']);
    pass('disabled pool preserves existing fallback key');

    process.env.GEMINI_POOL_ENABLED = 'true';
    const { client, marks } = makeClient([
      { id: '11111111-1111-1111-1111-111111111111', apiKey: 'pool-key-one-abcdefghijklmnopqrstuvwxyz' },
      { id: '22222222-2222-2222-2222-222222222222', apiKey: 'pool-key-two-abcdefghijklmnopqrstuvwxyz' },
    ]);
    const seen: string[] = [];
    const rotated = await runWithGeminiKeyPool({
      client,
      fallbackKey: 'fallback-key-abcdefghijklmnopqrstuvwxyz',
      rateLimitCode: 'GEMINI_RATE_LIMITED',
      authErrorCode: 'GEMINI_AUTH_ERROR',
      invoke: async (key) => {
        seen.push(key);
        if (key.includes('one')) throw new Error('GEMINI_RATE_LIMITED');
        return 'rotated-success';
      },
    });
    assert.equal(rotated, 'rotated-success');
    assert.deepEqual(seen, [
      'pool-key-one-abcdefghijklmnopqrstuvwxyz',
      'pool-key-two-abcdefghijklmnopqrstuvwxyz',
    ]);
    assert.deepEqual(marks.map((item) => item.result), ['RATE_LIMITED', 'SUCCESS']);
    pass('429 moves immediately to the next pool entry');

    const authCase = makeClient([
      { id: '33333333-3333-3333-3333-333333333333', apiKey: 'pool-key-bad-abcdefghijklmnopqrstuvwxyz' },
      { id: '44444444-4444-4444-4444-444444444444', apiKey: 'pool-key-good-abcdefghijklmnopqrstuvwxyz' },
    ]);
    const authResult = await runWithGeminiKeyPool({
      client: authCase.client,
      rateLimitCode: 'GEMINI_RATE_LIMITED',
      authErrorCode: 'GEMINI_AUTH_ERROR',
      invoke: async (key) => {
        if (key.includes('bad')) throw new Error('GEMINI_AUTH_ERROR');
        return 'auth-recovered';
      },
    });
    assert.equal(authResult, 'auth-recovered');
    assert.deepEqual(authCase.marks.map((item) => item.result), ['AUTH_ERROR', 'SUCCESS']);
    pass('auth failure skips the bad entry and continues');

    const exhausted = makeClient([
      { id: '55555555-5555-5555-5555-555555555555', apiKey: 'pool-key-five-abcdefghijklmnopqrstuvwxyz' },
      { id: '66666666-6666-6666-6666-666666666666', apiKey: 'pool-key-six-abcdefghijklmnopqrstuvwxyz' },
    ]);
    await assert.rejects(
      () => runWithGeminiKeyPool({
        client: exhausted.client,
        rateLimitCode: 'GEMINI_RATE_LIMITED',
        authErrorCode: 'GEMINI_AUTH_ERROR',
        invoke: async () => {
          throw new Error('GEMINI_RATE_LIMITED');
        },
      }),
      /GEMINI_RATE_LIMITED/
    );
    assert.deepEqual(exhausted.marks.map((item) => item.result), ['RATE_LIMITED', 'RATE_LIMITED']);
    pass('all rate-limited entries fail closed with canonical error');

    console.log(`ALL ${passed} GEMINI KEY POOL TESTS PASSED`);
  } finally {
    if (originalEnabled === undefined) delete process.env.GEMINI_POOL_ENABLED;
    else process.env.GEMINI_POOL_ENABLED = originalEnabled;
    if (originalMaster === undefined) delete process.env.GEMINI_POOL_MASTER_KEY_B64;
    else process.env.GEMINI_POOL_MASTER_KEY_B64 = originalMaster;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
