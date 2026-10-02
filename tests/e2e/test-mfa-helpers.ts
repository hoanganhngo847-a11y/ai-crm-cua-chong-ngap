import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { enrollTotpFactor, challengeAndVerifyTotp } from '@/lib/auth/mfa';

function base32ToBuffer(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secret: string, timeStepSeconds = 30): string {
  const key = base32ToBuffer(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

import { execSync } from 'child_process';

/**
 * Enrolls and verifies a TOTP factor for a logged-in Supabase client session,
 * elevating its Authenticator Assurance Level to AAL2. Idempotent across test runs.
 */
export async function elevateClientToAal2(
  client: SupabaseClient,
  factorName = 'Test TOTP Factor'
): Promise<void> {
  const { data: aalData } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData?.currentLevel === 'aal2') {
    return;
  }

  const {
    data: { user },
  } = await client.auth.getUser();

  if (user?.id) {
    try {
      execSync(
        `docker exec -i supabase_db_ai-crm-cua-chong-ngap psql -U postgres -d postgres -c "DELETE FROM auth.mfa_factors WHERE user_id = '${user.id}';"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } catch {
      // Ignore if docker container not reachable
    }
  }

  const uniqueName = `${factorName} ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const enrollRes = await enrollTotpFactor(client, uniqueName);
  try {
    const validOtp = generateTotpCode(enrollRes.secret);
    await challengeAndVerifyTotp(enrollRes.factorId, validOtp, client);
  } catch (_firstErr) {
    await new Promise((r) => setTimeout(r, 1000));
    const freshOtp = generateTotpCode(enrollRes.secret);
    await challengeAndVerifyTotp(enrollRes.factorId, freshOtp, client);
  }
}
