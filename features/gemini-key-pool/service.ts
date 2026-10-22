import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../lib/supabase/admin';

const MAX_POOL_KEYS = 30;
const DEFAULT_COOLDOWN_SECONDS = 75;

export interface EncryptedGeminiKey {
  ciphertext: string;
  iv: string;
  authTag: string;
  fingerprint: string;
}

interface ClaimedEncryptedKey {
  key_id: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

function masterKey(): Buffer {
  const raw = process.env.GEMINI_POOL_MASTER_KEY_B64;
  if (!raw) throw new Error('GEMINI_NOT_CONFIGURED');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('GEMINI_NOT_CONFIGURED');
  return key;
}

export function isGeminiKeyPoolEnabled(): boolean {
  return process.env.GEMINI_POOL_ENABLED?.trim().toLowerCase() === 'true';
}

export function encryptGeminiApiKey(apiKey: string): EncryptedGeminiKey {
  const normalized = apiKey.trim();
  if (normalized.length < 20 || normalized.length > 512 || /\s/.test(normalized)) {
    throw new Error('INVALID_GEMINI_API_KEY');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    fingerprint: createHash('sha256').update(normalized).digest('hex'),
  };
}

export function decryptGeminiApiKey(row: Pick<ClaimedEncryptedKey, 'ciphertext' | 'iv' | 'auth_tag'>): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(row.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function markResult(
  client: SupabaseClient,
  keyId: string,
  result: 'SUCCESS' | 'RATE_LIMITED' | 'AUTH_ERROR' | 'ERROR',
  errorCode?: string
): Promise<void> {
  try {
    await client.rpc('gemini_pool_mark_result', {
      p_key_id: keyId,
      p_result: result,
      p_error_code: errorCode || null,
      p_cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
    });
  } catch {
    // Pool health bookkeeping must never mask the provider result.
  }
}

export async function runWithGeminiKeyPool<T>(options: {
  invoke: (apiKey: string) => Promise<T>;
  fallbackKey?: string;
  rateLimitCode: string;
  authErrorCode: string;
  client?: SupabaseClient;
}): Promise<T> {
  if (!isGeminiKeyPoolEnabled()) {
    if (!options.fallbackKey) throw new Error('GEMINI_NOT_CONFIGURED');
    return options.invoke(options.fallbackKey);
  }

  const admin = options.client || createAdminClient();
  const { count, error: countError } = await admin
    .from('gemini_api_key_pool')
    .select('id', { count: 'exact', head: true })
    .eq('enabled', true);

  if (countError) throw new Error('GEMINI_PROVIDER_UNAVAILABLE');

  // Backwards-compatible fallback until the first pool key is saved.
  if (!count) {
    if (!options.fallbackKey) throw new Error('GEMINI_NOT_CONFIGURED');
    return options.invoke(options.fallbackKey);
  }

  const exclude: string[] = [];
  let lastError: unknown = null;
  const maxAttempts = Math.min(count, MAX_POOL_KEYS);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { data, error } = await admin.rpc('gemini_pool_claim_key', {
      p_exclude: exclude,
    });
    if (error) throw new Error('GEMINI_PROVIDER_UNAVAILABLE');

    const claimed = (Array.isArray(data) ? data[0] : data) as ClaimedEncryptedKey | null;
    if (!claimed?.key_id) break;
    exclude.push(claimed.key_id);

    let apiKey: string;
    try {
      apiKey = decryptGeminiApiKey(claimed);
    } catch {
      await markResult(admin, claimed.key_id, 'AUTH_ERROR', 'GEMINI_KEY_DECRYPT_FAILED');
      continue;
    }

    try {
      const result = await options.invoke(apiKey);
      await markResult(admin, claimed.key_id, 'SUCCESS');
      return result;
    } catch (err: unknown) {
      lastError = err;
      const code = err instanceof Error ? err.message : '';

      if (code === options.rateLimitCode) {
        await markResult(admin, claimed.key_id, 'RATE_LIMITED', code);
        continue;
      }
      if (code === options.authErrorCode) {
        await markResult(admin, claimed.key_id, 'AUTH_ERROR', code);
        continue;
      }

      await markResult(admin, claimed.key_id, 'ERROR', code || 'GEMINI_PROVIDER_ERROR');
      throw err;
    }
  }

  if (lastError) throw lastError;
  throw new Error(options.rateLimitCode);
}
