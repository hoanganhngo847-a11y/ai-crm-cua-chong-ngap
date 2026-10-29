'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { recordingActor } from '../../features/zalo-recordings/access';
import { createAdminClient } from '../../lib/supabase/admin';
import { customerForActor, sanitizeDossierText, uuid } from '../../features/customer-360/service';
import { processDossierRefresh } from '../../features/customer-360/worker';
import { bindCustomerIdentity } from '../../features/customer-360/identity';

export type DossierActionState = { message: string; ok: boolean };

export async function updateCustomerDossierField(input: {
  customerId: string;
  field: 'assigned_sale_name' | 'sale_notes' | 'marketing_notes' | 'ai_notes';
  value: string | null;
}): Promise<{ ok: boolean; message?: string; value?: string | null }> {
  try {
    const actor = await recordingActor();
    const customerId = uuid.parse(input.customerId);
    const validFields = ['assigned_sale_name', 'sale_notes', 'marketing_notes', 'ai_notes'] as const;
    if (!validFields.includes(input.field)) {
      return { ok: false, message: 'Trường cập nhật không hợp lệ.' };
    }

    const db = createAdminClient();
    await customerForActor(db, actor, customerId);

    const raw = (input.value ?? '').trim();
    let cleanValue: string | null = null;
    let assignedSaleIdToUpdate: string | null | undefined = undefined;

    if (input.field === 'assigned_sale_name') {
      cleanValue = raw ? raw.slice(0, 200) : null;
      if (cleanValue) {
        // Try to match an active sale/boss in company_members by full_name
        const { data: members } = await db
          .from('company_members')
          .select('user_id, user_profiles(full_name)')
          .eq('company_id', actor.companyId)
          .eq('status', 'ACTIVE')
          .in('role', ['SALE', 'BOSS_ADMIN']);

        const matched = members?.find((m) => {
          const profile = (Array.isArray(m.user_profiles) ? m.user_profiles[0] : m.user_profiles) as { full_name: string } | null;
          return profile?.full_name?.toLowerCase().trim() === cleanValue?.toLowerCase().trim();
        });
        if (matched) {
          assignedSaleIdToUpdate = matched.user_id as string;
        } else {
          assignedSaleIdToUpdate = null;
        }
      } else {
        assignedSaleIdToUpdate = null;
      }
    } else {
      // Notes: sanitize text
      cleanValue = raw ? sanitizeDossierText(raw, 4000) : null;
      if (raw && !cleanValue) {
        return { ok: false, message: 'Ghi chú chứa thông tin bảo mật hoặc nhạy cảm.' };
      }
    }

    const payload: Record<string, unknown> = {
      company_id: actor.companyId,
      customer_id: customerId,
      [input.field]: cleanValue,
      updated_by: actor.userId,
      updated_at: new Date().toISOString(),
    };

    if (assignedSaleIdToUpdate !== undefined) {
      payload.assigned_sale_id = assignedSaleIdToUpdate;
    }

    const { error } = await db
      .from('customer_dossier_profiles')
      .upsert(payload, { onConflict: 'company_id,customer_id' });

    if (error) {
      console.error('[c360_update_field_error]', error);
      throw new Error('UPDATE_FAILED');
    }

    revalidatePath(`/customers/${customerId}/dossier`);
    revalidatePath('/customers/dossier');

    return { ok: true, value: cleanValue };
  } catch (err) {
    console.error('[updateCustomerDossierField]', err);
    return { ok: false, message: 'Không thể cập nhật. Vui lòng thử lại.' };
  }
}

export async function setCustomerOutreachChannel(input: {
  customerId: string;
  channel: 'FACEBOOK' | 'ZALO';
  contacted: boolean;
}): Promise<{ ok: boolean; message?: string; value?: string | null }> {
  try {
    const actor = await recordingActor();
    const customerId = uuid.parse(input.customerId);
    if (input.channel !== 'FACEBOOK' && input.channel !== 'ZALO') {
      return { ok: false, message: 'Kênh tiếp cận không hợp lệ.' };
    }

    const db = createAdminClient();
    await customerForActor(db, actor, customerId);

    const value = input.contacted ? new Date().toISOString() : null;
    const field = input.channel === 'FACEBOOK' ? 'facebook_outreach_at' : 'zalo_outreach_at';
    const { error } = await db
      .from('customer_dossier_profiles')
      .upsert(
        {
          company_id: actor.companyId,
          customer_id: customerId,
          [field]: value,
          updated_by: actor.userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'company_id,customer_id' }
      );

    if (error) throw new Error('OUTREACH_UPDATE_FAILED');

    revalidatePath(`/customers/${customerId}/dossier`);
    revalidatePath('/customers/dossier');
    return { ok: true, value };
  } catch (err) {
    console.error('[setCustomerOutreachChannel]', err);
    return { ok: false, message: 'Không thể cập nhật kênh tiếp cận. Vui lòng thử lại.' };
  }
}

export async function saveDossierProfile(_state: DossierActionState, form: FormData): Promise<DossierActionState> {
  try {
    const actor = await recordingActor(true);
    const customerId = uuid.parse(form.get('customerId'));
    const db = createAdminClient();
    await customerForActor(db, actor, customerId);
    const input = z.object({
      address: z.string().trim().max(1000),
      special_notes: z.string().trim().max(4000),
      birth_year: z.number().int().min(1900).max(new Date().getUTCFullYear()).nullable(),
      assigned_sale_id: uuid.nullable(),
      assigned_sale_name: z.string().trim().max(200).nullable(),
      sale_notes: z.string().trim().max(4000).nullable(),
      marketing_notes: z.string().trim().max(4000).nullable(),
      ai_notes: z.string().trim().max(4000).nullable(),
    }).parse({
      address: form.get('address'),
      special_notes: form.get('specialNotes'),
      birth_year: form.get('birthYear') ? Number(form.get('birthYear')) : null,
      assigned_sale_id: form.get('assignedSale') || null,
      assigned_sale_name: form.get('assignedSaleName') ? String(form.get('assignedSaleName')).trim() : null,
      sale_notes: form.get('saleNotes') ? String(form.get('saleNotes')).trim() : null,
      marketing_notes: form.get('marketingNotes') ? String(form.get('marketingNotes')).trim() : null,
      ai_notes: form.get('aiNotes') ? String(form.get('aiNotes')).trim() : null,
    });
    if (input.assigned_sale_id) {
      const member = await db.from('company_members').select('user_id').eq('company_id', actor.companyId).eq('user_id', input.assigned_sale_id).eq('status', 'ACTIVE').in('role', ['SALE','BOSS_ADMIN']).maybeSingle();
      if (member.error || !member.data) throw new Error('INVALID_OWNER');
    }
    // Human profile remains human-entered. Mask phone/credentials before persistence.
    const address = input.address ? sanitizeDossierText(input.address, 1000) : null;
    const notes = input.special_notes ? sanitizeDossierText(input.special_notes, 4000) : null;
    const saleNotes = input.sale_notes ? sanitizeDossierText(input.sale_notes, 4000) : null;
    const marketingNotes = input.marketing_notes ? sanitizeDossierText(input.marketing_notes, 4000) : null;
    const aiNotes = input.ai_notes ? sanitizeDossierText(input.ai_notes, 4000) : null;
    if ((input.address && !address) || (input.special_notes && !notes)) return { ok: false, message: 'Loại bỏ thông tin bảo mật trước khi lưu.' };

    const payload: Record<string, unknown> = {
      company_id: actor.companyId,
      customer_id: customerId,
      address,
      special_notes: notes,
      birth_year: input.birth_year,
      assigned_sale_id: input.assigned_sale_id,
      updated_by: actor.userId,
      updated_at: new Date().toISOString(),
    };
    if (input.assigned_sale_name !== undefined) payload.assigned_sale_name = input.assigned_sale_name;
    if (saleNotes !== undefined) payload.sale_notes = saleNotes;
    if (marketingNotes !== undefined) payload.marketing_notes = marketingNotes;
    if (aiNotes !== undefined) payload.ai_notes = aiNotes;

    const { error } = await db.from('customer_dossier_profiles').upsert(payload, { onConflict: 'company_id,customer_id' });
    if (error) throw new Error('PROFILE_FAILED');
    revalidatePath(`/customers/${customerId}/dossier`); revalidatePath('/customers/dossier');
    return { ok: true, message: 'Đã lưu hồ sơ nhập thủ công.' };
  } catch { return { ok: false, message: 'Không lưu được hồ sơ. Kiểm tra dữ liệu và quyền truy cập.' }; }
}
export async function linkDossierEmail(_state: DossierActionState, form: FormData): Promise<DossierActionState> {
  try {
    const actor = await recordingActor(true);
    const customerId = uuid.parse(form.get('customerId'));
    const db = createAdminClient();
    await customerForActor(db, actor, customerId);
    const result = await bindCustomerIdentity(db, { companyId: actor.companyId, customerId, type: 'EMAIL',
      value: z.string().max(254).parse(form.get('email')), verified: false });
    revalidatePath(`/customers/${customerId}/dossier`); revalidatePath('/customers/dossier');
    return result.status === 'CONFLICT' ? { ok: false, message: 'Email đã thuộc hồ sơ khác. Đã ghi nhận xung đột để kiểm tra.' } : { ok: true, message: 'Đã thêm email (chưa xác minh).' };
  } catch { return { ok: false, message: 'Không liên kết được email. Hồ sơ hiện tại vẫn được giữ nguyên.' }; }
}
export async function saveDossierNote(_state: DossierActionState, form: FormData): Promise<DossierActionState> {
  try {
    const actor = await recordingActor();
    const customerId = uuid.parse(form.get('customerId'));
    const text = z.string().trim().min(1).max(2000).parse(form.get('note'));
    const sanitized = sanitizeDossierText(text);
    if (!sanitized) return { ok: false, message: 'Ghi chú chứa thông tin bảo mật. Vui lòng loại bỏ mật khẩu, mã xác thực hoặc token.' };
    const db = createAdminClient();
    await customerForActor(db, actor, customerId);
    const { error } = await db.from('interactions').insert({ company_id: actor.companyId, customer_id: customerId,
      type: 'NOTE', channel: 'WEBSITE', direction: 'OUTBOUND', actor_type: 'SALE', actor_user_id: actor.userId,
      sanitized_content: sanitized, sanitization_status: 'SUCCEEDED', sanitized_at: new Date().toISOString(), sanitizer_version: 'dossier-v1' });
    if (error) throw new Error('NOTE_FAILED');
    revalidatePath(`/customers/${customerId}/dossier`);
    return { ok: true, message: 'Đã lưu ghi chú của bạn. AI không sửa hoặc xóa ghi chú này.' };
  } catch { return { ok: false, message: 'Không lưu được ghi chú. Kiểm tra quyền hoặc kết nối rồi thử lại.' }; }
}
export async function requestDossierRefresh(_state: DossierActionState, form: FormData): Promise<DossierActionState> {
  try {
    const actor = await recordingActor(true);
    const customerId = uuid.parse(form.get('customerId'));
    const db = createAdminClient();
    await customerForActor(db, actor, customerId);
    if (process.env.CUSTOMER_DOSSIER_ENABLED !== 'true') return { ok: false, message: 'Phân tích AI chưa được bật cho môi trường này.' };
    const settings = await db.from('customer_dossier_settings').select('enabled').eq('company_id', actor.companyId).maybeSingle();
    if (settings.error || settings.data?.enabled !== true) return { ok: false, message: 'Phân tích AI chưa được bật cho công ty này.' };
    const { error } = await db.rpc('c360_request_refresh', { p_company_id: actor.companyId, p_customer_id: customerId });
    if (error) throw new Error('REFRESH_FAILED');
    const result = await processDossierRefresh({ db, companyId: actor.companyId, customerId });
    revalidatePath(`/customers/${customerId}/dossier`);
    revalidatePath('/customers/dossier');
    return { ok: result.status === 'COMPLETED', message: result.status === 'COMPLETED' ? 'Đã cập nhật phân tích AI.' : result.status === 'FAILED' ? 'AI chưa cập nhật được. Hồ sơ trước vẫn được giữ lại.' : 'Yêu cầu đã được ghi nhận hoặc đang xử lý. Tải lại để xem trạng thái.' };
  } catch { return { ok: false, message: 'Không thể cập nhật AI. Hồ sơ trước vẫn được giữ lại.' }; }
}
