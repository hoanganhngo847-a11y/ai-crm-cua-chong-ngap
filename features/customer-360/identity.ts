import 'server-only';
import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone, computePhoneHmac } from '../crm/services/customer.service';
import { sanitizeDossierText } from './service';

export function normalizeEmail(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('INVALID_EMAIL');
  return normalized;
}
export function normalizeIdentity(type: 'PHONE' | 'EMAIL' | 'ZALO' | 'FACEBOOK', value: string) {
  if (type === 'PHONE') return { key: computePhoneHmac(normalizePhone(value)), email: null };
  if (type === 'EMAIL') {
    const email = normalizeEmail(value);
    const secret = process.env.PHONE_HASH_SECRET;
    if (!secret?.trim()) throw new Error('IDENTITY_HASH_SECRET_REQUIRED');
    return { key: createHmac('sha256', secret.trim()).update(`email:${email}`).digest('hex'), email };
  }
  const key = value.trim();
  if (!key || key.length > 512 || /\s/.test(key)) throw new Error('INVALID_PROVIDER_ID');
  // Exact existing provider key, including account/page scope if used by ingress. Never derive from name.
  return { key, email: null };
}
/** Trusted ingestion/admin service only. Never expose verified/external IDs as browser inputs. */
export async function bindCustomerIdentity(db: SupabaseClient, input: {
  companyId: string; customerId: string; type: 'PHONE' | 'EMAIL' | 'ZALO' | 'FACEBOOK';
  value: string; displayName?: string; verified: boolean;
}) {
  const value = normalizeIdentity(input.type, input.value);
  const displayName = input.displayName ? sanitizeDossierText(input.displayName, 200) : null;
  if (input.displayName && !displayName) throw new Error('UNSAFE_IDENTITY_DISPLAY_NAME');
  const { data, error } = await db.rpc('c360_bind_identity', {
    p_company_id: input.companyId, p_customer_id: input.customerId, p_channel: input.type,
    p_external_id: value.key, p_display_name: displayName,
    p_verified: input.verified, p_email: value.email,
  });
  if (error || !data) throw new Error('IDENTITY_BIND_FAILED');
  return data as { status: 'LINKED' | 'EXISTING' | 'CONFLICT'; customerId?: string };
}

/** Exact, tenant-bound resolution; no fuzzy names and no implicit customer creation/merge.
 * Unverified phone/email may be shown as candidates, but never grant automatic attachment.
 */
export async function resolveCustomerIdentities(db: SupabaseClient, companyId: string,
  inputs: Array<{ type: 'PHONE' | 'EMAIL' | 'ZALO' | 'FACEBOOK'; value: string; verified: boolean }>) {
  if (!inputs.length || inputs.length > 8) throw new Error('INVALID_IDENTITIES');
  const keys = inputs.map(i => ({ ...i, ...normalizeIdentity(i.type, i.value) }));
  const { data, error } = await db.from('identities').select('id,customer_id,channel,external_id,verified')
    .eq('company_id', companyId).in('external_id', keys.map(k => k.key));
  if (error) throw new Error('IDENTITY_RESOLUTION_FAILED');
  const matches = (data || []).filter(row => keys.some(k => k.type === row.channel && k.key === row.external_id));
  const candidates = [...new Set(matches.map(m => m.customer_id as string))];
  if (candidates.length > 1) {
    // Record conflict against the exact already-bound identity; never rebind either customer.
    for (const match of matches.filter(m => m.customer_id !== candidates[0])) {
      const result = await db.rpc('c360_bind_identity', { p_company_id: companyId, p_customer_id: candidates[0],
        p_channel: match.channel, p_external_id: match.external_id,
        p_email: keys.find(k => k.type === match.channel && k.key === match.external_id)?.email ?? null });
      if (result.error) throw new Error('IDENTITY_CONFLICT_FAILED');
    }
    return { status: 'CONFLICT' as const, customerId: null };
  }
  const strong = matches.filter(row => keys.some(k => k.type === row.channel && k.key === row.external_id &&
    (['ZALO','FACEBOOK'].includes(k.type) || (k.verified && row.verified))));
  return strong.length ? { status: 'EXACT' as const, customerId: strong[0].customer_id as string }
    : { status: candidates.length ? 'SUGGESTION' as const : 'UNKNOWN' as const, customerId: null };
}
