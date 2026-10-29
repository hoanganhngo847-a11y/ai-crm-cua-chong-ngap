import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActorContext } from '@/shared/contracts/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { ACCOUNT_UUID } from './scope';
import { credentialsFingerprint, encryptZaloCredentials, parseZaloCredentials, ZaloAccountInputError } from './credentials';

export interface ZaloAccountSummary {
  id: string; label: string; enabled: boolean; revision: number;
  status: 'CONNECTING' | 'CONNECTED' | 'ERROR' | 'PAUSED'; provider_uid: string | null;
  error_code: string | null; last_heartbeat_at: string | null; created_at: string;
}
export function assertZaloAccountAdmin(actor: ActorContext | null): asserts actor is ActorContext & { companyId: string } {
  if (!actor || actor.profileStatus !== 'ACTIVE' || !actor.companyId || actor.membershipStatus !== 'ACTIVE' || actor.role !== 'BOSS_ADMIN' || actor.aal !== 'aal2') throw new Error('ZALO_ACCOUNT_ADMIN_REQUIRED');
}
export async function listZaloAccounts(companyId: string, client: SupabaseClient = createAdminClient()): Promise<ZaloAccountSummary[]> {
  const { data, error } = await client.rpc('list_zalo_accounts', { p_company_id: companyId });
  if (error) throw new Error('ZALO_ACCOUNT_READ_FAILED');
  return data || [];
}
export async function saveZaloAccount(actor: ActorContext | null, raw: Record<string, unknown>, client: SupabaseClient = createAdminClient()) {
  assertZaloAccountAdmin(actor);
  const label = typeof raw.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim() : '';
  if (!label || label.length > 80) throw new ZaloAccountInputError('Hãy nhập tên tài khoản, tối đa 80 ký tự.');
  const isNew = raw.id === undefined;
  const id = isNew ? randomUUID() : String(raw.id);
  if (!ACCOUNT_UUID.test(id)) throw new ZaloAccountInputError('Tài khoản chưa hợp lệ.');
  const credentials = parseZaloCredentials(raw as { cookie: unknown; imei: unknown; userAgent: unknown });
  const { error } = await client.rpc('save_zalo_account', {
    p_company_id: actor.companyId, p_id: id, p_label: label,
    p_encrypted: encryptZaloCredentials(actor.companyId, id, credentials),
    p_fingerprint: credentialsFingerprint(credentials), p_actor_id: actor.userId, p_is_new: isNew,
  });
  if (error?.code === '23505') throw new ZaloAccountInputError('Bộ cookie này đã được lưu cho một tài khoản. Hãy cập nhật tài khoản đó.');
  if (error?.message.includes('ZALO_ACCOUNT_LIMIT')) throw new ZaloAccountInputError('Bạn đã thêm đủ 3 tài khoản. Hãy cập nhật một tài khoản đã lưu.');
  if (error) throw new Error('ZALO_ACCOUNT_SAVE_FAILED');
  return id;
}
export async function toggleZaloAccount(actor: ActorContext | null, id: string, enabled: boolean, client: SupabaseClient = createAdminClient()) {
  assertZaloAccountAdmin(actor);
  if (!ACCOUNT_UUID.test(id)) throw new ZaloAccountInputError('Tài khoản chưa hợp lệ.');
  const { error } = await client.rpc('set_zalo_account_enabled', { p_company_id: actor.companyId, p_id: id, p_enabled: enabled, p_actor_id: actor.userId });
  if (error) throw new Error('ZALO_ACCOUNT_UPDATE_FAILED');
}
