'use server';

import { revalidatePath } from 'next/cache';
import { getActorContext, requireBossAdmin } from '../../lib/auth/context';
import { createAdminClient } from '../../lib/supabase/admin';
import { encryptGeminiApiKey } from '../../features/gemini-key-pool/service';

const MAX_KEYS = 30;

async function requirePoolAdmin() {
  const actor = await getActorContext();
  if (!actor?.companyId) throw new Error('Không xác định được doanh nghiệp.');
  await requireBossAdmin(actor.companyId);

  const adminCompany = process.env.GEMINI_POOL_ADMIN_COMPANY_ID;
  if (!adminCompany || adminCompany !== actor.companyId) {
    throw new Error('Tài khoản này không được phép quản lý Gemini key pool.');
  }
  return actor;
}

export async function getGeminiKeyPoolState() {
  await requirePoolAdmin();
  const { data, error } = await createAdminClient()
    .from('gemini_api_key_pool')
    .select('id,label,enabled,cooldown_until,last_used_at,last_success_at,last_error_code,consecutive_rate_limits,created_at')
    .order('created_at', { ascending: true });
  if (error) throw new Error('Không thể tải Gemini key pool.');
  return data || [];
}

export async function addGeminiApiKeys(formData: FormData) {
  const actor = await requirePoolAdmin();
  const raw = String(formData.get('keys') || '');
  const prefixRaw = String(formData.get('labelPrefix') || 'Gemini Project').trim();
  const labelPrefix = prefixRaw.slice(0, 80) || 'Gemini Project';

  const keys = Array.from(new Set(
    raw
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
  ));

  if (keys.length < 1 || keys.length > MAX_KEYS) {
    throw new Error('Mỗi lần chỉ được thêm từ 1 đến 30 API key.');
  }

  const admin = createAdminClient();
  const { count, error: countError } = await admin
    .from('gemini_api_key_pool')
    .select('id', { count: 'exact', head: true });
  if (countError) throw new Error('Không thể kiểm tra Gemini key pool.');
  if ((count || 0) + keys.length > MAX_KEYS) {
    throw new Error(`Pool tối đa ${MAX_KEYS} key. Hiện đã có ${count || 0} key.`);
  }

  let offset = count || 0;
  for (const key of keys) {
    const encrypted = encryptGeminiApiKey(key);
    const label = `${labelPrefix} ${String(offset + 1).padStart(2, '0')}`;
    const { error } = await admin.from('gemini_api_key_pool').insert({
      label,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      fingerprint: encrypted.fingerprint,
      created_by: actor.userId,
    });
    if (error) {
      if (error.code === '23505') throw new Error('Có API key đã tồn tại trong pool.');
      throw new Error('Không thể lưu API key vào pool.');
    }
    offset += 1;
  }

  await admin.from('audit_logs').insert({
    company_id: actor.companyId,
    user_id: actor.userId,
    action: 'GEMINI_KEY_POOL_ADD',
    resource_type: 'SYSTEM_CONFIG',
    result: 'SUCCESS',
    metadata: { added_count: keys.length },
  });

  revalidatePath('/admin/gemini-keys');
}

export async function toggleGeminiApiKey(formData: FormData) {
  const actor = await requirePoolAdmin();
  const id = String(formData.get('id') || '');
  const enabled = String(formData.get('enabled') || '') === 'true';
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Gemini key ID không hợp lệ.');

  const admin = createAdminClient();
  const { error } = await admin
    .from('gemini_api_key_pool')
    .update({ enabled, cooldown_until: enabled ? null : undefined, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error('Không thể cập nhật trạng thái API key.');

  await admin.from('audit_logs').insert({
    company_id: actor.companyId,
    user_id: actor.userId,
    action: enabled ? 'GEMINI_KEY_POOL_ENABLE' : 'GEMINI_KEY_POOL_DISABLE',
    resource_type: 'SYSTEM_CONFIG',
    resource_id: id,
    result: 'SUCCESS',
    metadata: {},
  });

  revalidatePath('/admin/gemini-keys');
}

export async function deleteGeminiApiKey(formData: FormData) {
  const actor = await requirePoolAdmin();
  const id = String(formData.get('id') || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Gemini key ID không hợp lệ.');

  const admin = createAdminClient();
  const { error } = await admin.from('gemini_api_key_pool').delete().eq('id', id);
  if (error) throw new Error('Không thể xóa API key.');

  await admin.from('audit_logs').insert({
    company_id: actor.companyId,
    user_id: actor.userId,
    action: 'GEMINI_KEY_POOL_DELETE',
    resource_type: 'SYSTEM_CONFIG',
    resource_id: id,
    result: 'SUCCESS',
    metadata: {},
  });

  revalidatePath('/admin/gemini-keys');
}
