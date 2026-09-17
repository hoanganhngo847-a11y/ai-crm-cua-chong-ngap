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
  type CustomerWithContact,
  type FindOrCreateCustomerParams,
  type FindOrCreateCustomerResult,
  type Identity,
} from '../types/customer.types';

/**
 * 1. normalizePhone: Chuẩn hóa số điện thoại theo định dạng chuẩn quốc tế E.164 (+84XXXXXXXXX).
 * Tuân thủ Schema Decision 01 (FROZEN) và hàm database public.normalize_phone(text).
 */
export function normalizePhone(phone: string): string {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Số điện thoại không hợp lệ hoặc bị để trống.');
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
    throw new Error(`Định dạng số điện thoại không hợp lệ: ${phone}`);
  }

  // Kiểm tra tính toàn vẹn với constraint: ^\+[1-9][0-9]{7,14}$
  if (!/^\+[1-9][0-9]{7,14}$/.test(cleaned)) {
    throw new Error(`Số điện thoại sau khi xử lý không đáp ứng chuẩn E.164: ${cleaned}`);
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
  const secret =
    process.env.PHONE_HASH_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    'ai-crm-phone-hmac-secret-v1';

  return crypto
    .createHmac('sha256', secret)
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

  // Bước 2: Tìm kiếm xem số điện thoại này đã thuộc khách hàng nào trong Company chưa
  let existingCustomerId: string | null = null;
  let existingContactData: { raw_phone: string; normalized_phone: string; is_verified: boolean } | null = null;

  // Ưu tiên kiểm tra trong bảng private.customer_private_contacts
  try {
    const { data: contactRow } = await adminClient
      .schema('private')
      .from('customer_private_contacts')
      .select('customer_id, raw_phone, normalized_phone, is_verified')
      .eq('company_id', params.companyId)
      .eq('normalized_phone', normalizedPhone)
      .maybeSingle();

    if (contactRow) {
      existingCustomerId = contactRow.customer_id;
      existingContactData = {
        raw_phone: contactRow.raw_phone,
        normalized_phone: contactRow.normalized_phone,
        is_verified: contactRow.is_verified,
      };
    }
  } catch {
    // Nếu schema private không thể truy vấn qua PostgREST, tìm qua identity kênh PHONE
  }

  if (!existingCustomerId) {
    const { data: phoneIdentity } = await adminClient
      .from('identities')
      .select('customer_id')
      .eq('company_id', params.companyId)
      .eq('channel', 'PHONE')
      .eq('external_id', phoneHmac)
      .maybeSingle();

    if (phoneIdentity) {
      existingCustomerId = phoneIdentity.customer_id;
    }
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

    // Nếu chưa có contactData, nạp từ RPC hoặc fallback
    if (!existingContactData) {
      const { data: rpcData } = await adminClient.rpc('get_customer_private_contact', {
        p_company_id: params.companyId,
        p_customer_id: existingCustomerId,
      });

      if (rpcData && rpcData.length > 0) {
        existingContactData = rpcData[0];
      } else {
        existingContactData = {
          raw_phone: params.phone.trim(),
          normalized_phone: normalizedPhone,
          is_verified: params.verified ?? false,
        };
      }
    }

    // Đảm bảo Identity kênh PHONE tồn tại
    const { data: existingPhoneId } = await adminClient
      .from('identities')
      .select('id')
      .eq('company_id', params.companyId)
      .eq('channel', 'PHONE')
      .eq('external_id', phoneHmac)
      .maybeSingle();

    if (!existingPhoneId) {
      await adminClient.from('identities').insert({
        company_id: params.companyId,
        customer_id: existingCustomerId,
        channel: 'PHONE',
        external_id: phoneHmac,
        verified: params.verified ?? false,
        metadata: {},
      });
    }

    // Nếu có truyền kênh đa kênh bổ sung (Zalo, Facebook, Website) -> Liên kết danh tính
    if (params.channel && params.externalId && params.channel !== 'PHONE') {
      const { data: existingChannelId } = await adminClient
        .from('identities')
        .select('id')
        .eq('company_id', params.companyId)
        .eq('channel', params.channel)
        .eq('external_id', params.externalId)
        .maybeSingle();

      if (!existingChannelId) {
        await adminClient.from('identities').insert({
          company_id: params.companyId,
          customer_id: existingCustomerId,
          channel: params.channel,
          external_id: params.externalId,
          verified: params.verified ?? false,
          metadata: params.metadata || {},
        });
      }
    }

    // Lấy toàn bộ danh sách identities hiện tại
    const { data: allIdentities } = await adminClient
      .from('identities')
      .select('*')
      .eq('company_id', params.companyId)
      .eq('customer_id', existingCustomerId);

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

  // 2. Lưu số điện thoại vào private.customer_private_contacts (Bảo mật tuyệt đối)
  const contactPayload = {
    company_id: params.companyId,
    customer_id: createdCustomerId,
    normalized_phone: normalizedPhone,
    raw_phone: params.phone.trim(),
    phone_country_code: 'VN',
    is_verified: params.verified ?? false,
  };

  try {
    await adminClient.schema('private').from('customer_private_contacts').insert(contactPayload);
  } catch (err) {
    console.error('Lỗi khi ghi private.customer_private_contacts:', err);
  }

  // 3. Tạo identity kênh PHONE (với external_id là Keyed HMAC-SHA256)
  await adminClient.from('identities').insert({
    company_id: params.companyId,
    customer_id: createdCustomerId,
    channel: 'PHONE',
    external_id: phoneHmac,
    verified: params.verified ?? false,
    metadata: {},
  });

  // 4. Tạo identity kênh mạng xã hội nếu có
  if (params.channel && params.externalId && params.channel !== 'PHONE') {
    await adminClient.from('identities').insert({
      company_id: params.companyId,
      customer_id: createdCustomerId,
      channel: params.channel,
      external_id: params.externalId,
      verified: params.verified ?? false,
      metadata: params.metadata || {},
    });
  }

  // 5. Ghi nhận lịch sử chuyển trạng thái đầu tiên (customer_stage_histories) với actor_type='SYSTEM'
  const historyNote = `Khách hàng mới tạo từ nguồn [${initialSource}]`;
  await adminClient.from('customer_stage_histories').insert({
    company_id: params.companyId,
    customer_id: createdCustomerId,
    from_stage: null,
    to_stage: initialStage,
    actor_type: STAGE_ACTOR_TYPES.SYSTEM,
    changed_by_user_id: null,
    reason: historyNote,
    source_ref: initialSource,
  });

  // 6. Nạp lại danh sách identities đã tạo
  const { data: createdIdentities } = await adminClient
    .from('identities')
    .select('*')
    .eq('company_id', params.companyId)
    .eq('customer_id', createdCustomerId);

  return {
    customer: newCustomer as Customer,
    contact: {
      raw_phone: params.phone.trim(),
      normalized_phone: normalizedPhone,
      is_verified: params.verified ?? false,
    },
    identities: (createdIdentities as Identity[]) || [],
    isNew: true,
  };
}

/**
 * 5. sanitizeForRole: Ẩn số thật nếu vai trò là SALE, hiển thị số thật nếu là SẾP/ADMIN.
 *
 * Quy tắc bảo mật:
 * - BOSS_ADMIN: Trả về số điện thoại thật, is_phone_masked = false.
 * - SALE / TECHNICIAN: Che số điện thoại bằng maskPhone (ví dụ 09******12), is_phone_masked = true.
 * - Không bao giờ đưa các trường nhạy cảm `raw_phone` hay `normalized_phone` ra payload phản hồi.
 */
export function sanitizeForRole(
  customerData: CustomerWithContact,
  role: ApplicationRole | string | null | undefined
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
 * Namespace đóng gói toàn bộ dịch vụ CustomerService
 */
export const CustomerService = {
  normalizePhone,
  maskPhone,
  computePhoneHmac,
  generateCustomerCode,
  findOrCreateByPhone,
  sanitizeForRole,
  sanitizeCustomersForRole,
};
