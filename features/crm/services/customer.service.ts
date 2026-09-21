import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { APPLICATION_ROLES, type ApplicationRole } from '../../../shared/constants/roles';
import {
  CUSTOMER_SOURCES,
  CUSTOMER_STAGES,
  STAGE_ACTOR_TYPES,
  type Customer,
  type CustomerResponse,
  type CustomerStage,
  type CustomerStageHistory,
  type CustomerWithContact,
  type FindOrCreateCustomerParams,
  type FindOrCreateCustomerResult,
  type Identity,
  type StageActorType,
  type UpdateCustomerStageParams,
  toCanonicalStage,
} from '../types/customer.types';

/**
 * 1. normalizePhone: Chuẩn hóa số điện thoại theo định dạng chuẩn quốc tế E.164 (+84XXXXXXXXX).
 * Tuân thủ Schema Decision 01 (FROZEN) và hàm database public.normalize_phone(text).
 */
export function normalizePhone(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Số điện thoại không đúng định dạng hợp lệ.');
  }

  // Loại bỏ toàn bộ ký tự khoảng trắng, dấu gạch ngang, chấm, ngoặc đơn
  let cleaned = phone.replace(/[^0-9+]/g, '');

  if (/^0[1-9][0-9]{8}$/.test(cleaned)) {
    // Định dạng số di động Việt Nam 10 chữ số bắt đầu bằng 0 (ví dụ: 0912345678 -> +84912345678)
    cleaned = '+84' + cleaned.slice(1);
  } else if (/^84[1-9][0-9]{8}$/.test(cleaned)) {
    // Bắt đầu bằng 84 nhưng thiếu dấu cộng (ví dụ: 84912345678 -> +84912345678)
    cleaned = '+' + cleaned;
  } else if (/^0[1-9][0-9]{7,13}$/.test(cleaned)) {
    // Số điện thoại trong nước độ dài biến thiên bắt đầu bằng 0
    cleaned = '+84' + cleaned.slice(1);
  } else if (/^84[1-9][0-9]{7,13}$/.test(cleaned)) {
    // Số bắt đầu bằng 84 độ dài biến thiên
    cleaned = '+' + cleaned;
  } else if (/^\+[1-9][0-9]{7,14}$/.test(cleaned)) {
    // Đã theo chuẩn quốc tế E.164 có dấu +
  } else {
    throw new Error('Số điện thoại không đúng định dạng hợp lệ.');
  }

  // Kiểm tra tính toàn vẹn với constraint: ^\+[1-9][0-9]{7,14}$
  if (!/^\+[1-9][0-9]{7,14}$/.test(cleaned)) {
    throw new Error('Số điện thoại không đúng định dạng hợp lệ.');
  }

  return cleaned;
}

/**
 * 2. maskPhone: Che số điện thoại cho Sale (ví dụ: 09******12).
 * Đảm bảo: Nếu số điện thoại ở dạng E.164 (+84...), chuyển đổi về dạng số điện thoại Việt Nam
 * thông thường (09x, 03x, 07x, 08x, 05x) trước khi che số, kết quả bắt buộc có định dạng: 09******12.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone || typeof phone !== 'string') {
    return '';
  }

  const trimmed = phone.trim();
  if (!trimmed) {
    return '';
  }

  // Nếu số đã ở dạng mask sẵn (chứa *)
  if (trimmed.includes('*')) {
    return trimmed;
  }

  // Chuyển đổi định dạng E.164 (+84) về dạng nội địa hiển thị (09x, 03x, 07x, 08x, 05x)
  let domestic = trimmed.replace(/[^0-9+]/g, '');
  if (domestic.startsWith('+84')) {
    domestic = '0' + domestic.slice(3);
  } else if (domestic.startsWith('84') && domestic.length >= 11) {
    domestic = '0' + domestic.slice(2);
  }

  if (domestic.length <= 4) {
    return '****';
  }

  // Luôn lấy 2 số đầu và 2 số cuối, phần giữa che bằng 6 dấu '*' (đạt định dạng chuẩn 09******12)
  const prefix = domestic.slice(0, 2);
  const suffix = domestic.slice(-2);
  const asterisks = '******';

  return `${prefix}${asterisks}${suffix}`;
}

/**
 * Tính toán Keyed HMAC-SHA256 của số điện thoại chuẩn hóa để lưu vào public.identities.
 * Đảm bảo thỏa mãn CHECK chk_identities_phone_external_id (channel <> 'PHONE' OR external_id ~ '^[0-9a-f]{64}$')
 */
export function computePhoneHmac(normalizedPhone: string): string {
  const secret = process.env.PHONE_HASH_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error('CONFIGURATION_ERROR: Thiếu biến môi trường PHONE_HASH_SECRET bắt buộc');
  }

  return crypto
    .createHmac('sha256', secret.trim())
    .update(normalizedPhone)
    .digest('hex');
}

/**
 * 3. generateCustomerCode: Sinh mã khách hàng KH-xxxxxx.
 * Tuân thủ Schema Decision 03 (PostgreSQL sequence customer_code_seq).
 */
export async function generateCustomerCode(client?: SupabaseClient): Promise<string> {
  try {
    const adminClient = client || createAdminClient();
    const { data, error } = await adminClient.rpc('generate_customer_code');
    if (!error && data && typeof data === 'string') {
      return data;
    }
  } catch {
    // Fallback nếu RPC không sẵn sàng trong môi trường offline / test hoặc thiếu env
  }

  // Fallback dựa trên timestamp ngẫu nhiên đảm bảo định dạng KH-xxxxxx
  const randomSuffix = Math.floor(100000 + Math.random() * 900000);
  return `KH-${randomSuffix}`;
}

/**
 * 4. findOrCreateByPhone: Dùng số điện thoại làm khóa chính để gộp khách và liên kết identity đa kênh.
 *
 * Quy trình xử lý:
 * 1. Chuẩn hóa số điện thoại theo chuẩn E.164.
 * 2. Tính mã băm HMAC-SHA256 phục vụ đối soát danh tính bảo mật.
 * 3. Tìm khách hàng đã tồn tại trong cùng Company thông qua private contact hoặc phone identity.
 * 4. Nếu đã tồn tại: Liên kết thêm Identity đa kênh (Zalo, Facebook, Website) nếu chưa có.
 * 5. Nếu chưa tồn tại: Tạo mới Customer, lưu số thật vào private schema, lưu identity PHONE (HMAC),
 *    lưu identity kênh nguồn và ghi lịch sử hành trình ban đầu (customer_stage_histories).
 */
export async function findOrCreateByPhone(
  params: FindOrCreateCustomerParams,
  client?: SupabaseClient
): Promise<FindOrCreateCustomerResult> {
  const adminClient = client || createAdminClient();

  if (!params.companyId) {
    throw new Error('companyId là bắt buộc.');
  }
  if (!params.name || !params.name.trim()) {
    throw new Error('Tên khách hàng là bắt buộc.');
  }

  // Bước 1: Chuẩn hóa số điện thoại
  const normalizedPhone = normalizePhone(params.phone);
  const phoneHmac = computePhoneHmac(normalizedPhone);

  // SERVER AUTHORITY (Lỗi P1 - Mục 9):
  // Mặc định khi chèn identity PHONE hoặc các kênh khác từ luồng CRM thủ công: is_verified = false, verified = false.
  // Chỉ có Webhook từ provider (hoặc quy trình xác thực OTP / trusted server với cờ isTrustedProvider: true)
  // mới có quyền thiết lập verified: true.
  const isVerifiedAuthority = Boolean(
    params.isTrustedProvider && (params.verified || (params as { is_verified?: boolean }).is_verified)
  );

  // Bước 2: Tìm kiếm xem số điện thoại này đã thuộc khách hàng nào trong Company chưa
  // Sử dụng Identity kênh PHONE với external_id là Keyed HMAC-SHA256 (Zero-Direct-Private-Access)
  let existingCustomerId: string | null = null;
  let existingContactData: { raw_phone: string; normalized_phone: string; is_verified: boolean } | null = null;

  const { data: phoneIdentity, error: findPhoneErr } = await adminClient
    .from('identities')
    .select('customer_id')
    .eq('company_id', params.companyId)
    .eq('channel', 'PHONE')
    .eq('external_id', phoneHmac)
    .maybeSingle();

  if (findPhoneErr) {
    throw new Error(`Lỗi truy vấn danh tính điện thoại: ${findPhoneErr.message}`);
  }

  if (phoneIdentity) {
    existingCustomerId = phoneIdentity.customer_id;
  }

  // ==========================================================================
  // TRƯỜNG HỢP 1: KHÁCH HÀNG ĐÃ TỒN TẠI -> GỘP VÀ LIÊN KẾT ĐA KÊNH
  // ==========================================================================
  if (existingCustomerId) {
    // Lấy thông tin Customer
    const { data: customer, error: custErr } = await adminClient
      .from('customers')
      .select('*')
      .eq('company_id', params.companyId)
      .eq('id', existingCustomerId)
      .single();

    if (custErr || !customer) {
      throw new Error(`Không tìm thấy hồ sơ khách hàng cho ID: ${existingCustomerId}`);
    }

    // Khởi tạo contactData từ thông tin người dùng cung cấp
    if (!existingContactData) {
      existingContactData = {
        raw_phone: params.phone.trim(),
        normalized_phone: normalizedPhone,
        is_verified: isVerifiedAuthority,
      };
    }

    // Đảm bảo Identity kênh PHONE tồn tại
    const { data: existingPhoneId, error: checkPhoneIdErr } = await adminClient
      .from('identities')
      .select('id')
      .eq('company_id', params.companyId)
      .eq('channel', 'PHONE')
      .eq('external_id', phoneHmac)
      .maybeSingle();

    if (checkPhoneIdErr) {
      throw new Error(`Lỗi kiểm tra danh tính điện thoại: ${checkPhoneIdErr.message}`);
    }

    if (!existingPhoneId) {
      const { error: insertPhoneErr } = await adminClient.from('identities').insert({
        company_id: params.companyId,
        customer_id: existingCustomerId,
        channel: 'PHONE',
        external_id: phoneHmac,
        verified: isVerifiedAuthority,
        metadata: {},
      });

      if (insertPhoneErr) {
        throw new Error(`Lỗi liên kết danh tính điện thoại: ${insertPhoneErr.message}`);
      }
    }

    // Nếu có truyền kênh đa kênh bổ sung (Zalo, Facebook, Website) -> Liên kết danh tính
    if (params.channel && params.externalId && params.channel !== 'PHONE') {
      const { data: existingChannelId, error: checkChannelErr } = await adminClient
        .from('identities')
        .select('id')
        .eq('company_id', params.companyId)
        .eq('channel', params.channel)
        .eq('external_id', params.externalId)
        .maybeSingle();

      if (checkChannelErr) {
        throw new Error(`Lỗi kiểm tra danh tính kênh ${params.channel}: ${checkChannelErr.message}`);
      }

      if (!existingChannelId) {
        const { error: insertChannelErr } = await adminClient.from('identities').insert({
          company_id: params.companyId,
          customer_id: existingCustomerId,
          channel: params.channel,
          external_id: params.externalId,
          verified: isVerifiedAuthority,
          metadata: params.metadata || {},
        });

        if (insertChannelErr) {
          throw new Error(`Lỗi liên kết danh tính kênh ${params.channel}: ${insertChannelErr.message}`);
        }
      }
    }

    // Lấy toàn bộ danh sách identities hiện tại
    const { data: allIdentities, error: listIdentitiesErr } = await adminClient
      .from('identities')
      .select('*')
      .eq('company_id', params.companyId)
      .eq('customer_id', existingCustomerId);

    if (listIdentitiesErr) {
      throw new Error(`Lỗi nạp danh sách danh tính: ${listIdentitiesErr.message}`);
    }

    return {
      customer: customer as Customer,
      contact: existingContactData!,
      identities: (allIdentities as Identity[]) || [],
      isNew: false,
    };
  }

  // ==========================================================================
  // TRƯỜNG HỢP 2: KHÁCH HÀNG CHƯA TỒN TẠI -> TẠO MỚI HỒ SƠ & LIÊN KẾT
  // ==========================================================================
  const initialSource =
    params.source ||
    (params.channel === 'ZALO'
      ? CUSTOMER_SOURCES.ZALO
      : params.channel === 'FACEBOOK'
        ? CUSTOMER_SOURCES.FACEBOOK
        : params.channel === 'WEBSITE'
          ? CUSTOMER_SOURCES.WEBSITE
          : CUSTOMER_SOURCES.MANUAL);

  // Ánh xạ stage ban đầu: Nếu truyền 'KHACH_MOI' hoặc không truyền thì mặc định là LEAD_NEW (Khách mới)
  const initialStage =
    params.stage === 'KHACH_MOI' || !params.stage
      ? CUSTOMER_STAGES.LEAD_NEW
      : params.stage;

  // 1. Tạo Customer trong public.customers
  const { data: newCustomer, error: insertCustErr } = await adminClient
    .from('customers')
    .insert({
      company_id: params.companyId,
      name: params.name.trim(),
      source: initialSource,
      stage: initialStage,
    })
    .select('*')
    .single();

  if (insertCustErr || !newCustomer) {
    throw new Error(`Lỗi tạo hồ sơ khách hàng: ${insertCustErr?.message || 'Không rõ lỗi'}`);
  }

  const createdCustomerId = newCustomer.id;

  // Helper dọn dẹp (Compensation Rollback) đảm bảo tính nguyên tử khi tạo khách hàng mới
  const rollbackNewCustomer = async () => {
    const safeDelete = async (queryBuilder: any, filters: Record<string, string>) => {
      if (!queryBuilder || typeof queryBuilder.delete !== 'function') return;
      let q = queryBuilder.delete();
      for (const [col, val] of Object.entries(filters)) {
        if (q && typeof q.eq === 'function') {
          q = q.eq(col, val);
        }
      }
      if (q && typeof q.then === 'function') {
        await q;
      }
    };

    // Thứ tự xóa: Dọn dẹp từ bảng phụ thuộc (child) trước để tránh vi phạm Foreign Key constraint
    // 1. customer_stage_histories
    try {
      await safeDelete(adminClient.from('customer_stage_histories'), {
        customer_id: createdCustomerId,
        company_id: params.companyId,
      });
    } catch (e) {
      console.error('[CustomerService.findOrCreateByPhone] Rollback customer_stage_histories error:', e);
    }

    // 2. identities
    try {
      await safeDelete(adminClient.from('identities'), {
        customer_id: createdCustomerId,
        company_id: params.companyId,
      });
    } catch (e) {
      console.error('[CustomerService.findOrCreateByPhone] Rollback identities error:', e);
    }

    // 3. customer_private_contacts (private zone)
    try {
      const PRIVATE_CONTACTS_TABLE = 'customer_private_contacts';
      const privateClient = typeof adminClient.schema === 'function' ? adminClient.schema('private') : adminClient;
      await safeDelete(privateClient.from(PRIVATE_CONTACTS_TABLE), {
        customer_id: createdCustomerId,
        company_id: params.companyId,
      });
    } catch (e) {
      console.error('[CustomerService.findOrCreateByPhone] Rollback customer_private_contacts error:', e);
    }

    // 4. customers (bản ghi chính)
    try {
      await safeDelete(adminClient.from('customers'), {
        id: createdCustomerId,
        company_id: params.companyId,
      });
    } catch (e) {
      console.error('[CustomerService.findOrCreateByPhone] Rollback customers error:', e);
    }
  };

  try {
    // 2. Lưu canonical private contact vào private zone (private.customer_private_contacts)
    const PRIVATE_CONTACTS_TABLE = 'customer_private_contacts';
    const privateClient = typeof adminClient.schema === 'function' ? adminClient.schema('private') : adminClient;
    const privateContactQuery = privateClient.from(PRIVATE_CONTACTS_TABLE);

    if (typeof privateContactQuery?.insert === 'function') {
      const { error: insertContactErr } = await privateContactQuery.insert({
        company_id: params.companyId,
        customer_id: createdCustomerId,
        raw_phone: params.phone.trim(),
        normalized_phone: normalizedPhone,
        phone_country_code: 'VN',
        is_verified: isVerifiedAuthority,
      });

      if (insertContactErr) {
        throw new Error(`Lỗi lưu thông tin liên hệ bảo mật: ${insertContactErr.message}`);
      }
    }

    // 3. Tạo identity kênh PHONE (với external_id là Keyed HMAC-SHA256)
    const { error: insertPhoneErr } = await adminClient.from('identities').insert({
      company_id: params.companyId,
      customer_id: createdCustomerId,
      channel: 'PHONE',
      external_id: phoneHmac,
      verified: isVerifiedAuthority,
      metadata: {},
    });

    if (insertPhoneErr) {
      throw new Error(`Lỗi tạo danh tính số điện thoại khách hàng: ${insertPhoneErr.message}`);
    }

    // 4. Tạo identity kênh mạng xã hội nếu có
    if (params.channel && params.externalId && params.channel !== 'PHONE') {
      const { error: insertSocialErr } = await adminClient.from('identities').insert({
        company_id: params.companyId,
        customer_id: createdCustomerId,
        channel: params.channel,
        external_id: params.externalId,
        verified: isVerifiedAuthority,
        metadata: params.metadata || {},
      });

      if (insertSocialErr) {
        throw new Error(`Lỗi tạo danh tính kênh ${params.channel}: ${insertSocialErr.message}`);
      }
    }

    // 5. Ghi nhận lịch sử chuyển trạng thái đầu tiên (customer_stage_histories) với actor_type='SYSTEM'
    const historyNote = params.note?.trim()
      ? `Khách hàng mới tạo từ nguồn [${initialSource}]: ${params.note.trim()}`
      : `Khách hàng mới tạo từ nguồn [${initialSource}]`;
    const { error: insertHistErr } = await adminClient.from('customer_stage_histories').insert({
      company_id: params.companyId,
      customer_id: createdCustomerId,
      from_stage: null,
      to_stage: initialStage,
      actor_type: STAGE_ACTOR_TYPES.SYSTEM,
      changed_by_user_id: null,
      reason: historyNote,
      source_ref: initialSource,
    });

    if (insertHistErr) {
      throw new Error(`Lỗi ghi nhận lịch sử trạng thái ban đầu: ${insertHistErr.message}`);
    }

    // 6. Nạp lại danh sách identities đã tạo
    const { data: createdIdentities, error: fetchIdentitiesErr } = await adminClient
      .from('identities')
      .select('*')
      .eq('company_id', params.companyId)
      .eq('customer_id', createdCustomerId);

    if (fetchIdentitiesErr) {
      throw new Error(`Lỗi truy vấn danh tính sau khi tạo: ${fetchIdentitiesErr.message}`);
    }

    return {
      customer: newCustomer as Customer,
      contact: {
        raw_phone: params.phone.trim(),
        normalized_phone: normalizedPhone,
        is_verified: isVerifiedAuthority,
      },
      identities: (createdIdentities as Identity[]) || [],
      isNew: true,
    };
  } catch (creationError: any) {
    // Atomic Compensation: Dọn dẹp sạch sẽ không để lại bản ghi rác / orphan records
    await rollbackNewCustomer();
    throw creationError;
  }
}

/**
 * 5. sanitizeForRole: Ẩn số thật nếu vai trò là SALE, hiển thị số thật nếu là SẾP/ADMIN.
 *
 * Quy tắc bảo mật:
 * - BOSS_ADMIN: Trả về số điện thoại thật, is_phone_masked = false.
 * - SALE / TECHNICIAN: Che số điện thoại bằng maskPhone (ví dụ 09******12), is_phone_masked = true.
 * - Không bao giờ đưa các trường nhạy cảm `raw_phone` hay `normalized_phone` ra payload phản hồi.
 */
// ============================================================================
// In-Memory Mock Stage & History Tracking for Phase 2
// ============================================================================
export const mockCustomerStages: Record<string, CustomerStage> = {
  'cust-1': 'PRICE_OFFERED',
  'cust-2': 'SURVEY_SCHEDULED',
  'cust-3': 'WARRANTY_ACTIVE',
  'cust-4': 'DEPOSIT_CONFIRMED',
};

export const mockStageHistories: CustomerStageHistory[] = [];

export { toCanonicalStage };

/**
 * 5. updateStage: Cập nhật giai đoạn khách hàng và lưu vết lịch sử (Strict Append-Only).
 * Tuân thủ docs/SUPABASE_SCHEMA_DESIGN.md (Mục 6.6: customer_stage_histories)
 *
 * Khóa lỗ hổng Cross-Tenant (P0):
 * - Bắt buộc tham số companyId (lấy từ server membership context).
 * - Resource Authorization: Query khách hàng với điều kiện (id = customerId AND company_id = companyId).
 * - Nếu không tìm thấy hoặc thuộc tenant khác: Ném lỗi 404 Not Found (fail-closed, không để lộ dữ liệu).
 * - Cập nhật stage & updated_at với điều kiện (id = customerId AND company_id = companyId).
 * - Ghi bản ghi vào customer_stage_histories (Strict Append-Only).
 * - Loại bỏ hoàn toàn cơ chế mock fallback: lỗi DB phải fail-closed và ném lỗi.
 */
export async function updateStage(
  customerIdOrParams: string | UpdateCustomerStageParams,
  companyIdOrNewStage?: string | CustomerStage | SupabaseClient,
  newStageOrClient?: CustomerStage | string | SupabaseClient,
  actorType?: StageActorType | string,
  note?: string,
  client?: SupabaseClient
): Promise<{ customer: Customer; history: CustomerStageHistory }> {
  let customerId: string;
  let companyId: string;
  let newStage: string;
  let actorTypeVal: StageActorType = STAGE_ACTOR_TYPES.USER;
  let actorId: string | null = null;
  let noteVal: string | undefined = undefined;
  let sourceRefVal: string | null = null;
  let adminClient: SupabaseClient;

  if (typeof customerIdOrParams === 'object' && customerIdOrParams !== null) {
    const p = customerIdOrParams;
    customerId = p.customerId;
    companyId = p.companyId;
    newStage = String(p.to_stage || p.newStage || '');
    actorTypeVal = (p.actorType as StageActorType) || STAGE_ACTOR_TYPES.USER;
    actorId = p.actorId || p.userId || null;
    noteVal = p.note;
    sourceRefVal = p.sourceRef || null;
    adminClient = (companyIdOrNewStage as SupabaseClient) || client || createAdminClient();
  } else {
    customerId = customerIdOrParams;
    const secondArg = String(companyIdOrNewStage || '');
    const isSecondArgStage =
      Object.values(CUSTOMER_STAGES).includes(secondArg as any) ||
      ['DA_CO_GIA', 'DANG_THUONG_LUONG', 'KHACH_MOI'].includes(secondArg.toUpperCase());

    if (isSecondArgStage) {
      throw new Error('companyId là tham số bắt buộc để xác thực quyền truy cập và ngăn chặn lỗ hổng Cross-Tenant.');
    }

    companyId = secondArg;
    newStage = String(newStageOrClient || '');
    actorTypeVal = (actorType as StageActorType) || STAGE_ACTOR_TYPES.USER;
    noteVal = note;
    adminClient = client || createAdminClient();
  }

  if (!customerId || !customerId.trim()) {
    throw new Error('Mã khách hàng (customerId) là bắt buộc.');
  }
  if (!companyId || !companyId.trim()) {
    throw new Error('companyId là tham số bắt buộc để xác thực quyền truy cập và ngăn chặn lỗ hổng Cross-Tenant.');
  }
  if (!newStage || (typeof newStage === 'string' && !newStage.trim())) {
    throw new Error('Giai đoạn mới (newStage) là bắt buộc.');
  }

  // Thắt chặt Runtime Allowlist - Lỗi P1 (Mục 12):
  // Thẩm định to_stage/newStage qua allowlist trước khi thực hiện UPDATE vào CSDL
  const canonicalNewStage = toCanonicalStage(newStage);
  const now = new Date().toISOString();

  // 1. Resource Authorization trước khi update:
  // Truy vấn customer từ database với điều kiện cả id = customerId VÀ company_id = companyId
  const { data: dbCustomer, error: fetchErr } = await adminClient
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (fetchErr) {
    throw new Error(`Lỗi truy vấn cơ sở dữ liệu: ${fetchErr.message}`);
  }

  // Nếu không tìm thấy hoặc customer thuộc công ty khác: Ném lỗi 404 Not Found (chặn đứng cross-tenant)
  if (!dbCustomer) {
    const notFoundError = new Error('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.');
    (notFoundError as any).status = 404;
    (notFoundError as any).code = 'NOT_FOUND';
    throw notFoundError;
  }

  const oldStage = dbCustomer.stage as CustomerStage;
  const previousUpdatedAt = dbCustomer.updated_at;

  // 2. Cập nhật stage và updated_at cho customer với điều kiện id = customerId VÀ company_id = companyId
  const { data: updCustomer, error: updErr } = await adminClient
    .from('customers')
    .update({
      stage: canonicalNewStage,
      updated_at: now,
    })
    .eq('id', customerId)
    .eq('company_id', companyId)
    .select()
    .single();

  if (updErr || !updCustomer) {
    throw new Error(`Lỗi cập nhật bảng customers: ${updErr?.message || 'Không thể cập nhật khách hàng'}`);
  }

  // 3. Ghi bản ghi mới vào bảng customer_stage_histories (Strict Append-Only)
  // chứa customer_id, company_id, from_stage, to_stage, actor_type, actor_id, note, created_at
  const stageReason = noteVal || `Chuyển giai đoạn sang [${canonicalNewStage}]`;
  let histRow: any = null;
  let histErr: any = null;

  try {
    let histInsertQuery: any = adminClient
      .from('customer_stage_histories')
      .insert({
        company_id: companyId,
        customer_id: customerId,
        from_stage: oldStage,
        to_stage: canonicalNewStage,
        actor_type: actorTypeVal,
        changed_by_user_id: actorId,
        reason: stageReason,
        source_ref: sourceRefVal,
        changed_at: now,
      });

    if (typeof histInsertQuery?.select === 'function') {
      histInsertQuery = histInsertQuery.select();
    }
    if (typeof histInsertQuery?.single === 'function') {
      histInsertQuery = histInsertQuery.single();
    }

    const histRes = await histInsertQuery;
    histRow = histRes?.data;
    histErr = histRes?.error;
  } catch (caughtErr: any) {
    histErr = caughtErr;
  }

  if (histErr || !histRow) {
    // Atomic Compensation Rollback: Nếu ghi lịch sử thất bại, hoàn tác stage về lại oldStage
    try {
      const custQuery: any = adminClient.from('customers');
      if (typeof custQuery?.update === 'function') {
        const rollbackPayload: Record<string, any> = { stage: oldStage };
        if (previousUpdatedAt) {
          rollbackPayload.updated_at = previousUpdatedAt;
        }
        let q = custQuery.update(rollbackPayload);
        if (q && typeof q.eq === 'function') {
          q = q.eq('id', customerId);
          if (q && typeof q.eq === 'function') {
            q = q.eq('company_id', companyId);
          }
        }
        if (q && typeof q.then === 'function') {
          await q;
        }
      }
    } catch (rbErr: any) {
      console.error(
        `[CustomerService.updateStage] Lỗi khi hoàn tác rollback stage về ${oldStage} cho customer ${customerId}:`,
        rbErr
      );
    }

    throw new Error(`Lỗi ghi lịch sử customer_stage_histories: ${histErr?.message || 'Không thể ghi lịch sử'}`);
  }

  const rawHist = histRow as Record<string, any>;
  const historyRecord: CustomerStageHistory = {
    id: rawHist.id,
    company_id: rawHist.company_id,
    customer_id: rawHist.customer_id,
    from_stage: rawHist.from_stage,
    to_stage: rawHist.to_stage,
    actor_type: rawHist.actor_type,
    changed_by_user_id: rawHist.changed_by_user_id,
    actor_id: rawHist.changed_by_user_id,
    reason: rawHist.reason,
    note: rawHist.reason,
    source_ref: rawHist.source_ref,
    changed_at: rawHist.changed_at,
    created_at: rawHist.changed_at,
  };

  return {
    customer: updCustomer as Customer,
    history: historyRecord,
  };
}

/**
 * Lấy lịch sử chuyển đổi giai đoạn của khách hàng (Strict Append-Only)
 */
export async function getStageHistories(
  companyId: string,
  customerId: string,
  client?: SupabaseClient
): Promise<CustomerStageHistory[]> {
  if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
    throw new Error('companyId là tham số bắt buộc để xác thực quyền truy cập.');
  }
  if (!customerId || typeof customerId !== 'string' || !customerId.trim()) {
    throw new Error('customerId là tham số bắt buộc.');
  }

  const effectiveCompanyId = companyId.trim();
  const effectiveCustomerId = customerId.trim();
  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

  let adminClient: SupabaseClient | null = null;
  try {
    adminClient = client || createAdminClient();
  } catch (err) {
    if (!isDemoMode) {
      throw new Error(`DATABASE_ERROR: Không thể kết nối Supabase Client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (adminClient) {
    let query: any = adminClient.from('customer_stage_histories').select('*');
    if (typeof query?.eq === 'function') {
      query = query.eq('company_id', effectiveCompanyId);
      if (typeof query?.eq === 'function') {
        query = query.eq('customer_id', effectiveCustomerId);
      }
    }
    if (typeof query?.order === 'function') {
      query = query.order('changed_at', { ascending: false });
    }

    const { data, error } = await query;

    if (error) {
      if (!isDemoMode) {
        throw new Error(`DATABASE_ERROR: Lỗi truy vấn customer_stage_histories: ${error.message}`);
      }
    } else if (data) {
      // Defense in depth: Đảm bảo lọc chuẩn xác theo cả company_id và customer_id
      return (data as CustomerStageHistory[]).filter(
        (h) => h.company_id === effectiveCompanyId && h.customer_id === effectiveCustomerId
      );
    }
  }

  // Fallback mock store chỉ kích hoạt khi có cờ explicit NEXT_PUBLIC_DEMO_MODE === 'true'
  if (isDemoMode) {
    return mockStageHistories
      .filter((h) => h.company_id === effectiveCompanyId && h.customer_id === effectiveCustomerId)
      .sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
  }

  return [];
}

/**
 * 6. evaluateUrgency: Xác định lý do ưu tiên cao trong Hàng chờ "CẦN SALE CHỐT"
 * - DA_CO_GIA (PRICE_OFFERED) -> "Đã có giá"
 * - DANG_THUONG_LUONG (NEGOTIATING) -> "Đang thương lượng"
 * - PENDING_SALE -> "Khách phản hồi mới"
 */
export function evaluateUrgency(
  customer: { id: string; stage: string },
  pendingSaleCustomerIds?: Set<string>
): { isUrgent: boolean; reason?: 'PRICE_OFFERED' | 'NEGOTIATING' | 'PENDING_REPLY'; label?: string } {
  if (pendingSaleCustomerIds?.has(customer.id)) {
    return {
      isUrgent: true,
      reason: 'PENDING_REPLY',
      label: 'Khách phản hồi mới',
    };
  }

  let canonicalStage: CustomerStage | null = null;
  try {
    canonicalStage = customer.stage ? toCanonicalStage(customer.stage) : null;
  } catch {
    canonicalStage = null;
  }
  if (canonicalStage === CUSTOMER_STAGES.PRICE_OFFERED) {
    return {
      isUrgent: true,
      reason: 'PRICE_OFFERED',
      label: 'Đã có giá',
    };
  }

  if (canonicalStage === CUSTOMER_STAGES.NEGOTIATING) {
    return {
      isUrgent: true,
      reason: 'NEGOTIATING',
      label: 'Đang thương lượng',
    };
  }

  return { isUrgent: false };
}

/**
 * 7. sanitizeForRole: Ẩn số thật nếu vai trò là SALE, hiển thị số thật nếu là SẾP/ADMIN.
 *
 * Quy tắc bảo mật:
 * - BOSS_ADMIN: Trả về số điện thoại thật, is_phone_masked = false.
 * - SALE / TECHNICIAN: Che số điện thoại bằng maskPhone (ví dụ 09******12), is_phone_masked = true.
 * - Không bao giờ đưa các trường nhạy cảm `raw_phone` hay `normalized_phone` ra payload phản hồi.
 */
export function sanitizeForRole(
  customerData: CustomerWithContact,
  role: ApplicationRole | string | null | undefined,
  urgency?: { reason?: string; label?: string }
): CustomerResponse {
  const isBossAdmin = role === APPLICATION_ROLES.BOSS_ADMIN;

  let displayPhone: string | undefined;

  if (customerData.contact) {
    const rawOrNormalized =
      customerData.contact.raw_phone || customerData.contact.normalized_phone || '';

    if (isBossAdmin) {
      displayPhone = rawOrNormalized;
    } else {
      displayPhone = maskPhone(rawOrNormalized);
    }
  } else if (!isBossAdmin) {
    const meta = (customerData.customer as any)?.metadata as Record<string, any> | undefined;
    if (meta?.masked_phone && typeof meta.masked_phone === 'string') {
      displayPhone = maskPhone(meta.masked_phone);
    }
  }

  return {
    id: customerData.customer.id,
    company_id: customerData.customer.company_id,
    customer_code: customerData.customer.customer_code,
    name: customerData.customer.name,
    source: customerData.customer.source,
    stage: customerData.customer.stage,
    phone: displayPhone,
    is_phone_masked: !isBossAdmin,
    identities: customerData.identities,
    urgency_reason: urgency?.reason,
    urgency_label: urgency?.label,
    created_at: customerData.customer.created_at,
    updated_at: customerData.customer.updated_at,
  };
}

/**
 * Helper làm sạch danh sách khách hàng theo vai trò.
 */
export function sanitizeCustomersForRole(
  customersWithContact: CustomerWithContact[],
  role: ApplicationRole | string | null | undefined
): CustomerResponse[] {
  return customersWithContact.map((item) => sanitizeForRole(item, role));
}

/**
 * 8. getUrgentClosingCustomers: Lọc khách hàng ưu tiên cao thuộc Hàng chờ "CẦN SALE CHỐT"
 * - Khách ở trạng thái DA_CO_GIA (PRICE_OFFERED), DANG_THUONG_LUONG (NEGOTIATING), hoặc khách có tin nhắn phản hồi mới (PENDING_SALE).
 * - Luôn bảo vệ an toàn Zero-Phone: che số đối với tài khoản vai trò SALE.
 */
export async function getUrgentClosingCustomers(
  companyId: string,
  limit: number = 5,
  role?: ApplicationRole | string | null | undefined,
  pendingSaleCustomerIds?: Set<string>,
  client?: SupabaseClient
): Promise<CustomerResponse[]> {
  if (!companyId || typeof companyId !== 'string' || !companyId.trim()) {
    throw new Error('companyId là tham số bắt buộc để xác thực quyền truy cập và ngăn chặn lỗ hổng Cross-Tenant.');
  }

  const effectiveCompanyId = companyId.trim();
  const effectiveLimit = typeof limit === 'number' && limit > 0 ? limit : 5;
  const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

  let adminClient: SupabaseClient | null = null;
  try {
    adminClient = client || createAdminClient();
  } catch (clientErr) {
    if (!isDemoMode) {
      throw new Error(`DATABASE_ERROR: Không thể kết nối database: ${clientErr instanceof Error ? clientErr.message : String(clientErr)}`);
    }
  }

  let customers: Customer[] = [];

  if (adminClient) {
    let query: any = adminClient
      .from('customers')
      .select('*')
      .eq('company_id', effectiveCompanyId)
      .in('stage', [CUSTOMER_STAGES.PRICE_OFFERED, CUSTOMER_STAGES.NEGOTIATING]);

    if (typeof query?.order === 'function') {
      query = query.order('created_at', { ascending: false });
    }

    if (typeof query?.limit === 'function') {
      query = query.limit(effectiveLimit);
    }

    const { data, error } = await query;

    if (error) {
      if (!isDemoMode) {
        throw new Error(`DATABASE_ERROR: Lỗi truy vấn danh sách khách hàng cần chốt: ${error.message}`);
      }
    } else if (data) {
      // Hàng rào bảo vệ nhiều lớp (Defense in depth): Lọc lại lần nữa theo company_id
      customers = (data as Customer[]).filter((c) => c.company_id === effectiveCompanyId);
    }
  }

  // Fallback mock store chỉ kích hoạt khi có cờ explicit NEXT_PUBLIC_DEMO_MODE === 'true'
  if (customers.length === 0 && isDemoMode) {
    const allMockCustomers: Customer[] = [
      {
        id: 'cust-1',
        company_id: '00000000-0000-0000-0000-000000000001',
        customer_code: 'KH-000001',
        name: 'Anh Hoàng Nam',
        source: CUSTOMER_SOURCES.FACEBOOK,
        stage: mockCustomerStages['cust-1'] || CUSTOMER_STAGES.PRICE_OFFERED,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'cust-2',
        company_id: '00000000-0000-0000-0000-000000000001',
        customer_code: 'KH-000002',
        name: 'Chị Mai Phương',
        source: CUSTOMER_SOURCES.ZALO,
        stage: mockCustomerStages['cust-2'] || CUSTOMER_STAGES.NEGOTIATING,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'cust-3',
        company_id: '00000000-0000-0000-0000-000000000001',
        customer_code: 'KH-000003',
        name: 'Bác Quốc Tuấn',
        source: CUSTOMER_SOURCES.HOTLINE,
        stage: mockCustomerStages['cust-3'] || CUSTOMER_STAGES.CARE_NURTURING,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];
    customers = allMockCustomers.filter((c) => c.company_id === effectiveCompanyId);
  }

  const mockPhoneMap: Record<string, string> = {
    'cust-1': '0912345612',
    'cust-2': '0934567890',
    'cust-3': '0987654321',
    'cust-4': '0977889900',
  };

  const urgentList: CustomerResponse[] = [];

  for (const c of customers) {
    const urgency = evaluateUrgency(c, pendingSaleCustomerIds);
    if (urgency.isUrgent) {
      const rawPhone = (isDemoMode && mockPhoneMap[c.id]) ? mockPhoneMap[c.id] : '';
      const sanitized = sanitizeForRole(
        {
          customer: c,
          contact: rawPhone ? { raw_phone: rawPhone, normalized_phone: normalizePhone(rawPhone) } : null,
        },
        role,
        urgency
      );
      urgentList.push(sanitized);
    }
  }

  return urgentList.slice(0, effectiveLimit);
}

/**
 * Namespace đóng gói toàn bộ dịch vụ CustomerService
 */
export const CustomerService = {
  normalizePhone,
  maskPhone,
  computePhoneHmac,
  generateCustomerCode,
  findOrCreateByPhone,
  toCanonicalStage,
  updateStage,
  getStageHistories,
  evaluateUrgency,
  getUrgentClosingCustomers,
  mockCustomerStages,
  mockStageHistories,
  sanitizeForRole,
  sanitizeCustomersForRole,
};
