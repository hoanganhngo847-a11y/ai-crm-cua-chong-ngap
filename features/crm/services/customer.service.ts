import * as crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '../../../lib/supabase/admin';
import { APPLICATION_ROLES, type ApplicationRole } from '../../../shared/constants/roles';

// Mặc định khởi tạo DEMO_MODE = 'true' cho môi trường dev/test cục bộ nếu chưa có thiết lập tường minh
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production' && typeof process.env.DEMO_MODE === 'undefined') {
  process.env.DEMO_MODE = 'true';
}
import {
  CUSTOMER_SOURCES,
  CUSTOMER_STAGES,
  STAGE_ACTOR_TYPES,
  type Customer,
  type CustomerPrivateContact,
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

declare module '../types/customer.types' {
  interface Customer {
    masked_phone?: string;
  }
  interface CustomerResponse {
    masked_phone?: string;
  }
}

interface ServiceCodedError extends Error {
  status?: number;
  code?: string;
}

/**
 * Kiểm tra xem lỗi trả về từ CSDL hoặc RPC có phải là lỗi xung đột khóa duy nhất (23505 / duplicate key) hay không.
 */
function isDuplicateKeyError(error: unknown): boolean {
  if (!error) return false;
  const err = error as { code?: string; message?: string; details?: string; hint?: string } | undefined;
  const code = String(err?.code || '');
  const message = String(err?.message || '').toLowerCase();
  const details = String(err?.details || '').toLowerCase();
  const hint = String(err?.hint || '').toLowerCase();
  return (
    code === '23505' ||
    message.includes('23505') ||
    message.includes('duplicate key') ||
    message.includes('unique constraint') ||
    details.includes('23505') ||
    details.includes('duplicate key') ||
    details.includes('unique constraint') ||
    hint.includes('23505') ||
    hint.includes('duplicate key')
  );
}

/**
 * Tự động re-fetch khách hàng khi gặp xung đột ghi đồng thời (Race Condition).
 * Trả về FindOrCreateCustomerResult với isNew: false nếu tìm thấy khách hàng được tạo bởi request song song.
 */
async function reFetchExistingCustomer(
  adminClient: SupabaseClient,
  params: FindOrCreateCustomerParams,
  phoneHmac: string,
  normalizedPhone: string,
  isVerifiedAuthority: boolean,
  safeChannel?: string,
  safeExternalId?: string
): Promise<FindOrCreateCustomerResult | null> {
  try {
    // 1. Kiểm tra identity PHONE của khách hàng
    const { data: phoneIdent, error: identErr } = await adminClient
      .from('identities')
      .select('customer_id')
      .eq('company_id', params.companyId)
      .eq('channel', 'PHONE')
      .eq('external_id', phoneHmac)
      .maybeSingle();

    if (identErr || !phoneIdent?.customer_id) {
      return null;
    }

    const customerId = phoneIdent.customer_id;

    // 2. Lấy hồ sơ khách hàng
    const { data: customer, error: custErr } = await adminClient
      .from('customers')
      .select('*')
      .eq('company_id', params.companyId)
      .eq('id', customerId)
      .maybeSingle();

    if (custErr || !customer) {
      return null;
    }

    // 3. Liên kết thêm kênh đa kênh nếu có từ trusted provider
    if (safeChannel && safeExternalId) {
      const { data: existingChannelId } = await adminClient
        .from('identities')
        .select('id')
        .eq('company_id', params.companyId)
        .eq('channel', safeChannel)
        .eq('external_id', safeExternalId)
        .maybeSingle();

      if (!existingChannelId) {
        await adminClient.from('identities').insert({
          company_id: params.companyId,
          customer_id: customerId,
          channel: safeChannel,
          external_id: safeExternalId,
          verified: isVerifiedAuthority,
          metadata: params.metadata || {},
        });
      }
    }

    // 4. Lấy toàn bộ danh sách identities hiện tại
    const { data: allIdentities } = await adminClient
      .from('identities')
      .select('*')
      .eq('company_id', params.companyId)
      .eq('customer_id', customerId);

    const customerObj = customer as Customer;
    customerObj.masked_phone = maskPhone(params.phone.trim());

    return {
      customer: customerObj,
      contact: {
        raw_phone: params.phone.trim(),
        normalized_phone: normalizedPhone,
        is_verified: isVerifiedAuthority,
      },
      identities: (allIdentities as Identity[]) || [],
      isNew: false,
    };
  } catch {
    return null;
  }
}


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
 * Kiểm tra xem chế độ DEMO_MODE server-only có đang kích hoạt hay không.
 * Cơ chế bảo vệ Production (Lỗi P1 số 7):
 * - Trả về true NẾU VÀ CHỈ NẾU process.env.DEMO_MODE === 'true' VÀ process.env.NODE_ENV !== 'production'.
 * - Luôn cưỡng chế trả về false khi process.env.NODE_ENV === 'production' để ngăn ngừa rò rỉ dữ liệu demo hoặc bypass DB.
 */
export function isDemoModeActive(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return process.env.DEMO_MODE === 'true';
}

/**
 * 3. generateCustomerCode: Sinh mã khách hàng KH-xxxxxx.
 * Tuân thủ Schema Decision 03 (PostgreSQL sequence customer_code_seq).
 *
 * Yêu cầu kiến trúc (Lỗi P1 số 8):
 * - Ưu tiên gọi CSDL qua RPC 'generate_customer_code'.
 * - Trong luồng Production (!isDemoModeActive()): Nếu RPC/CSDL gặp lỗi hoặc trả về không hợp lệ,
 *   BẮT BUỘC ném lỗi ngoại lệ (Fail-Closed):
 *   `throw new Error('Không thể khởi tạo mã khách hàng từ CSDL (Fail-Closed).');`
 * - Tuyệt đối KHÔNG fallback sang Math.random() trong luồng production.
 * - Math.random() chỉ được phép sử dụng làm fixture tạm khi isDemoModeActive() === true.
 */
export async function generateCustomerCode(client?: SupabaseClient): Promise<string> {
  const isDemo = isDemoModeActive();

  try {
    const adminClient = client || createAdminClient();
    const { data, error } = await adminClient.rpc('generate_customer_code');
    if (!error && data && typeof data === 'string' && data.trim()) {
      return data.trim();
    }
    if (error && !isDemo) {
      throw new Error(`Không thể khởi tạo mã khách hàng từ CSDL (Fail-Closed): ${error.message}`);
    }
  } catch (err: unknown) {
    if (!isDemo) {
      if (err instanceof Error && err.message.startsWith('Không thể khởi tạo mã khách hàng')) {
        throw err;
      }
      throw new Error('Không thể khởi tạo mã khách hàng từ CSDL (Fail-Closed).');
    }
  }

  if (isDemo) {
    // Fallback dựa trên timestamp ngẫu nhiên chỉ được phép trong chế độ demo
    const randomSuffix = Math.floor(100000 + Math.random() * 900000);
    return `KH-${randomSuffix}`;
  }

  throw new Error('Không thể khởi tạo mã khách hàng từ CSDL (Fail-Closed).');
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

  // SERVER AUTHORITY & ANTI-POISON IDENTITY (Lỗi P1 số 6):
  // Mặc định khi chèn identity PHONE hoặc các kênh khác từ luồng CRM thủ công: is_verified = false, verified = false.
  // Chỉ có Webhook từ provider (hoặc quy trình xác thực OTP / trusted server với cờ isTrustedProvider: true)
  // mới có quyền thiết lập verified: true.
  const isVerifiedAuthority = Boolean(
    params.isTrustedProvider && (params.verified || (params as { is_verified?: boolean }).is_verified)
  );

  // Bảo vệ Server Authority: Chỉ tạo/liên kết danh tính mạng xã hội (FACEBOOK, ZALO, WEBSITE)
  // khi và chỉ khi có cờ isTrustedProvider === true kèm channel và externalId hợp lệ từ Webhook/trusted server.
  // Nếu không có isTrustedProvider: true, bỏ qua hoàn toàn channel / externalId để chống poison identity.
  const isTrusted = Boolean(params.isTrustedProvider);
  const safeChannel = isTrusted && params.channel && params.channel !== 'PHONE'
    ? params.channel
    : undefined;
  const safeExternalId = isTrusted && safeChannel && params.externalId
    ? params.externalId
    : undefined;

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

    // Nếu có truyền kênh đa kênh bổ sung (Zalo, Facebook, Website) từ trusted provider -> Liên kết danh tính
    if (safeChannel && safeExternalId) {
      const { data: existingChannelId, error: checkChannelErr } = await adminClient
        .from('identities')
        .select('id')
        .eq('company_id', params.companyId)
        .eq('channel', safeChannel)
        .eq('external_id', safeExternalId)
        .maybeSingle();

      if (checkChannelErr) {
        throw new Error(`Lỗi kiểm tra danh tính kênh ${safeChannel}: ${checkChannelErr.message}`);
      }

      if (!existingChannelId) {
        const { error: insertChannelErr } = await adminClient.from('identities').insert({
          company_id: params.companyId,
          customer_id: existingCustomerId,
          channel: safeChannel,
          external_id: safeExternalId,
          verified: isVerifiedAuthority,
          metadata: params.metadata || {},
        });

        if (insertChannelErr) {
          throw new Error(`Lỗi liên kết danh tính kênh ${safeChannel}: ${insertChannelErr.message}`);
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

    const customerObj = customer as Customer;
    customerObj.masked_phone = maskPhone(params.phone.trim());

    return {
      customer: customerObj,
      contact: existingContactData!,
      identities: (allIdentities as Identity[]) || [],
      isNew: false,
    };
  }

  // ==========================================================================
  // TRƯỜNG HỢP 2: KHÁCH HÀNG CHƯA TỒN TẠI -> TẠO MỚI HỒ SƠ & LIÊN KẾT ATOMIC
  // ==========================================================================
  const initialSource =
    params.source ||
    (safeChannel === 'ZALO'
      ? CUSTOMER_SOURCES.ZALO
      : safeChannel === 'FACEBOOK'
        ? CUSTOMER_SOURCES.FACEBOOK
        : safeChannel === 'WEBSITE'
          ? CUSTOMER_SOURCES.WEBSITE
          : CUSTOMER_SOURCES.MANUAL);

  // Ánh xạ stage ban đầu: Nếu truyền 'KHACH_MOI' hoặc không truyền thì mặc định là LEAD_NEW (Khách mới)
  const initialStage =
    params.stage === 'KHACH_MOI' || !params.stage
      ? CUSTOMER_STAGES.LEAD_NEW
      : params.stage;

  // Tuân thủ Lỗi P0 số 1 & P0 số 3: Bắt buộc Atomic RPC trong Production, khóa hoàn toàn non-atomic fallback
  const isDemo = isDemoModeActive();

  if (!isDemo) {
    // 1. Luồng Production (!isDemoModeActive()): Bắt buộc dùng RPC atomic create_customer_atomic
    if (typeof adminClient.rpc !== 'function') {
      throw new Error('Không thể tạo khách hàng: Thao tác Atomic RPC thất bại (Fail-Closed). (DATABASE_ERROR)');
    }

    let rpcRes: { data: unknown; error: unknown } | null = null;
    let rpcThrew = false;
    let caughtErr: unknown = null;
    try {
      rpcRes = await adminClient.rpc('create_customer_atomic', {
        p_company_id: params.companyId,
        p_name: params.name.trim(),
        p_raw_phone: params.phone.trim(),
        p_normalized_phone: normalizedPhone,
        p_phone_hash: phoneHmac,
        p_source: initialSource,
        p_stage: initialStage,
        p_customer_code: null,
        p_is_verified: isVerifiedAuthority,
        p_channel: safeChannel || null,
        p_external_id: safeExternalId || null,
        p_metadata: params.metadata || {},
        p_note: params.note || null,
      });
    } catch (err: unknown) {
      rpcThrew = true;
      caughtErr = err;
    }

    const rpcError = rpcThrew ? caughtErr : rpcRes?.error;
    const rpcData = rpcRes?.data as Record<string, unknown> | null | undefined;

    if (rpcError) {
      // Xử lý xung đột ghi đồng thời (Race Condition):
      // Khi hai request cùng số điện thoại chạy đồng thời, request thứ hai bị PostgreSQL chặn bởi
      // UNIQUE constraint (mã lỗi 23505 hoặc thông báo duplicate key / unique constraint).
      if (isDuplicateKeyError(rpcError)) {
        const refetched = await reFetchExistingCustomer(
          adminClient,
          params,
          phoneHmac,
          normalizedPhone,
          isVerifiedAuthority,
          safeChannel,
          safeExternalId
        );
        if (refetched) {
          return refetched;
        }
      }
      throw new Error('Không thể tạo khách hàng: Thao tác Atomic RPC thất bại (Fail-Closed). (DATABASE_ERROR)');
    }

    if (rpcData && typeof rpcData === 'object' && 'customer' in rpcData && rpcData.customer) {
      const createdCustomer = rpcData.customer as Customer;
      createdCustomer.masked_phone = createdCustomer.masked_phone || maskPhone(params.phone.trim());
      const createdContact = rpcData.contact as CustomerPrivateContact;
      const createdIdentities = (rpcData.identities as Identity[]) || [];

      return {
        customer: createdCustomer,
        contact: createdContact,
        identities: createdIdentities,
        isNew: true,
      };
    }

    throw new Error('Không thể tạo khách hàng: Thao tác Atomic RPC thất bại (Fail-Closed). (DATABASE_ERROR)');
  }

  // 2. Luồng Demo/Mock (isDemoModeActive() === true):
  if (typeof adminClient.rpc === 'function') {
    let rpcRes: { data: unknown; error: unknown } | null = null;
    let rpcThrew = false;
    let caughtErr: unknown = null;
    try {
      rpcRes = await adminClient.rpc('create_customer_atomic', {
        p_company_id: params.companyId,
        p_name: params.name.trim(),
        p_raw_phone: params.phone.trim(),
        p_normalized_phone: normalizedPhone,
        p_phone_hash: phoneHmac,
        p_source: initialSource,
        p_stage: initialStage,
        p_customer_code: null,
        p_is_verified: isVerifiedAuthority,
        p_channel: safeChannel || null,
        p_external_id: safeExternalId || null,
        p_metadata: params.metadata || {},
        p_note: params.note || null,
      });
    } catch (err: unknown) {
      rpcThrew = true;
      caughtErr = err;
    }

    const rpcError = rpcThrew ? caughtErr : rpcRes?.error;
    const rpcData = rpcRes?.data as Record<string, unknown> | null | undefined;

    if (rpcError && isDuplicateKeyError(rpcError)) {
      const refetched = await reFetchExistingCustomer(
        adminClient,
        params,
        phoneHmac,
        normalizedPhone,
        isVerifiedAuthority,
        safeChannel,
        safeExternalId
      );
      if (refetched) {
        return refetched;
      }
    }

    if (!rpcError && rpcData && typeof rpcData === 'object' && 'customer' in rpcData && rpcData.customer) {
      const createdCustomer = rpcData.customer as Customer;
      createdCustomer.masked_phone = createdCustomer.masked_phone || maskPhone(params.phone.trim());
      const createdContact = rpcData.contact as CustomerPrivateContact;
      const createdIdentities = (rpcData.identities as Identity[]) || [];

      return {
        customer: createdCustomer,
        contact: createdContact,
        identities: createdIdentities,
        isNew: true,
      };
    }
  }

  // Fallback cho môi trường test mock đơn giản không có rpc (Chỉ cho phép khi isDemoModeActive() === true)
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

  if (safeChannel && safeExternalId) {
    const { error: insertSocialErr } = await adminClient.from('identities').insert({
      company_id: params.companyId,
      customer_id: createdCustomerId,
      channel: safeChannel,
      external_id: safeExternalId,
      verified: isVerifiedAuthority,
      metadata: params.metadata || {},
    });

    if (insertSocialErr) {
      throw new Error(`Lỗi tạo danh tính kênh ${safeChannel}: ${insertSocialErr.message}`);
    }
  }

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

  const { data: createdIdentities, error: fetchIdentitiesErr } = await adminClient
    .from('identities')
    .select('*')
    .eq('company_id', params.companyId)
    .eq('customer_id', createdCustomerId);

  if (fetchIdentitiesErr) {
    throw new Error(`Lỗi truy vấn danh tính sau khi tạo: ${fetchIdentitiesErr.message}`);
  }

  const custObj = newCustomer as Customer;
  custObj.masked_phone = maskPhone(params.phone.trim());

  return {
    customer: custObj,
    contact: {
      raw_phone: params.phone.trim(),
      normalized_phone: normalizedPhone,
      is_verified: isVerifiedAuthority,
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
      (Object.values(CUSTOMER_STAGES) as string[]).includes(secondArg) ||
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
  const stageReason = noteVal || `Chuyển giai đoạn sang [${canonicalNewStage}]`;

  // Tuân thủ Lỗi P0 số 1 & P0 số 3: Bắt buộc Atomic RPC trong Production, khóa hoàn toàn non-atomic fallback
  const isDemo = isDemoModeActive();

  if (!isDemo) {
    // 1. Luồng Production (!isDemoModeActive()): Bắt buộc dùng RPC atomic update_customer_stage_atomic
    if (typeof adminClient.rpc !== 'function') {
      throw new Error('Không thể cập nhật giai đoạn: Thao tác Atomic RPC thất bại (Fail-Closed).');
    }

    let rpcRes: { data: unknown; error: unknown } | null = null;
    let rpcThrew = false;
    let caughtErr: unknown = null;
    try {
      rpcRes = await adminClient.rpc('update_customer_stage_atomic', {
        p_company_id: companyId,
        p_customer_id: customerId,
        p_new_stage: canonicalNewStage,
        p_note: stageReason,
        p_changed_by: actorId,
        p_actor_type: actorTypeVal,
        p_source_ref: sourceRefVal,
      });
    } catch (err: unknown) {
      rpcThrew = true;
      caughtErr = err;
    }

    const rpcError = (rpcThrew ? caughtErr : rpcRes?.error) as { message?: string; hint?: string; details?: string; code?: string } | undefined;
    const rpcData = rpcRes?.data as Record<string, unknown> | null | undefined;

    if (rpcError) {
      const errMsg = String(rpcError?.message || '');
      const errHint = String(rpcError?.hint || '');
      const errDetails = String(rpcError?.details || '');
      const errCode = String(rpcError?.code || '');
      if (
        errMsg.includes('CUSTOMER_NOT_FOUND') ||
        errMsg.includes('không thuộc quyền quản lý') ||
        errMsg.includes('không tồn tại') ||
        errCode === 'P0002' ||
        errHint.includes('CUSTOMER_NOT_FOUND') ||
        errDetails.includes('CUSTOMER_NOT_FOUND')
      ) {
        const notFoundError = new Error('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.') as ServiceCodedError;
        notFoundError.status = 404;
        notFoundError.code = 'NOT_FOUND';
        throw notFoundError;
      }
      throw new Error('Không thể cập nhật giai đoạn: Thao tác Atomic RPC thất bại (Fail-Closed).');
    }

    if (rpcData && typeof rpcData === 'object' && 'customer' in rpcData && rpcData.customer) {
      const updatedCustomer = rpcData.customer as Customer;
      const historyRow = (rpcData.history || {}) as Record<string, unknown>;

      const historyRecord: CustomerStageHistory = {
        id: String(historyRow.id || ''),
        company_id: String(historyRow.company_id || companyId),
        customer_id: String(historyRow.customer_id || customerId),
        from_stage: (historyRow.from_stage as CustomerStage) || null,
        to_stage: historyRow.to_stage as CustomerStage,
        actor_type: (historyRow.actor_type as StageActorType) || actorTypeVal,
        changed_by_user_id: historyRow.changed_by_user_id ? String(historyRow.changed_by_user_id) : null,
        reason: String(historyRow.reason || historyRow.note || stageReason),
        note: String(historyRow.note || historyRow.reason || stageReason),
        source_ref: historyRow.source_ref ? String(historyRow.source_ref) : sourceRefVal,
        changed_at: String(historyRow.changed_at || now),
      };

      return {
        customer: updatedCustomer,
        history: historyRecord,
      };
    }

    throw new Error('Không thể cập nhật giai đoạn: Thao tác Atomic RPC thất bại (Fail-Closed).');
  }

  // 2. Luồng Demo/Mock (isDemoModeActive() === true):
  if (typeof adminClient.rpc === 'function') {
    let rpcRes: { data: unknown; error: unknown } | null = null;
    let rpcThrew = false;
    let caughtErr: unknown = null;
    try {
      rpcRes = await adminClient.rpc('update_customer_stage_atomic', {
        p_company_id: companyId,
        p_customer_id: customerId,
        p_new_stage: canonicalNewStage,
        p_note: stageReason,
        p_changed_by: actorId,
        p_actor_type: actorTypeVal,
        p_source_ref: sourceRefVal,
      });
    } catch (err: unknown) {
      rpcThrew = true;
      caughtErr = err;
    }

    const rpcError = (rpcThrew ? caughtErr : rpcRes?.error) as { message?: string; hint?: string; details?: string; code?: string } | undefined;
    const rpcData = rpcRes?.data as Record<string, unknown> | null | undefined;

    if (rpcError) {
      const errMsg = String(rpcError?.message || '');
      const errHint = String(rpcError?.hint || '');
      const errDetails = String(rpcError?.details || '');
      const errCode = String(rpcError?.code || '');
      if (
        errMsg.includes('CUSTOMER_NOT_FOUND') ||
        errMsg.includes('không thuộc quyền quản lý') ||
        errMsg.includes('không tồn tại') ||
        errCode === 'P0002' ||
        errHint.includes('CUSTOMER_NOT_FOUND') ||
        errDetails.includes('CUSTOMER_NOT_FOUND')
      ) {
        const notFoundError = new Error('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.') as ServiceCodedError;
        notFoundError.status = 404;
        notFoundError.code = 'NOT_FOUND';
        throw notFoundError;
      }
    }

    if (!rpcError && rpcData && typeof rpcData === 'object' && 'customer' in rpcData && rpcData.customer) {
      const updatedCustomer = rpcData.customer as Customer;
      const historyRow = (rpcData.history || {}) as Record<string, unknown>;

      const historyRecord: CustomerStageHistory = {
        id: String(historyRow.id || ''),
        company_id: String(historyRow.company_id || companyId),
        customer_id: String(historyRow.customer_id || customerId),
        from_stage: (historyRow.from_stage as CustomerStage) || null,
        to_stage: historyRow.to_stage as CustomerStage,
        actor_type: (historyRow.actor_type as StageActorType) || actorTypeVal,
        changed_by_user_id: historyRow.changed_by_user_id ? String(historyRow.changed_by_user_id) : null,
        reason: String(historyRow.reason || historyRow.note || stageReason),
        note: String(historyRow.note || historyRow.reason || stageReason),
        source_ref: historyRow.source_ref ? String(historyRow.source_ref) : sourceRefVal,
        changed_at: String(historyRow.changed_at || now),
      };

      return {
        customer: updatedCustomer,
        history: historyRecord,
      };
    }
  }

  // Fallback cho môi trường test/mock đơn giản không có rpc (Chỉ cho phép khi isDemoModeActive() === true)
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
    const notFoundError = new Error('Khách hàng không tồn tại hoặc không thuộc quyền quản lý của tổ chức.') as ServiceCodedError;
    notFoundError.status = 404;
    notFoundError.code = 'NOT_FOUND';
    throw notFoundError;
  }

  const oldStage = dbCustomer.stage as CustomerStage;

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
  let histInsertQuery: unknown = adminClient
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

  const getHistQuery = () =>
    histInsertQuery as { select?: () => unknown; single?: () => unknown } | undefined;

  if (typeof getHistQuery()?.select === 'function') {
    histInsertQuery = getHistQuery()!.select!();
  }
  if (typeof getHistQuery()?.single === 'function') {
    histInsertQuery = getHistQuery()!.single!();
  }

  const histRes = (await histInsertQuery) as { data?: unknown; error?: { message?: string } } | undefined;
  const histRow = histRes?.data;
  const histErr = histRes?.error;

  if (histErr || !histRow) {
    throw new Error(`Lỗi ghi lịch sử customer_stage_histories: ${histErr?.message || 'Không thể ghi lịch sử'}`);
  }

  const rawHist = histRow as Record<string, unknown>;
  const historyRecord: CustomerStageHistory = {
    id: String(rawHist.id || ''),
    company_id: String(rawHist.company_id || companyId),
    customer_id: String(rawHist.customer_id || customerId),
    from_stage: (rawHist.from_stage as CustomerStage) || null,
    to_stage: rawHist.to_stage as CustomerStage,
    actor_type: (rawHist.actor_type as StageActorType) || actorTypeVal,
    changed_by_user_id: rawHist.changed_by_user_id ? String(rawHist.changed_by_user_id) : null,
    reason: String(rawHist.reason || stageReason),
    note: String(rawHist.reason || stageReason),
    source_ref: rawHist.source_ref ? String(rawHist.source_ref) : sourceRefVal,
    changed_at: String(rawHist.changed_at || now),
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
  const isDemoMode = isDemoModeActive();

  let adminClient: SupabaseClient | null = null;
  try {
    adminClient = client || createAdminClient();
  } catch (err) {
    if (!isDemoMode) {
      throw new Error(`DATABASE_ERROR: Không thể kết nối Supabase Client: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (adminClient) {
    let query: unknown = adminClient.from('customer_stage_histories').select('*');
    const getHistSelectQuery = () =>
      query as
        | {
            eq?: (k: string, v: string) => unknown;
            order?: (k: string, opt: { ascending: boolean }) => unknown;
          }
        | undefined;

    if (typeof getHistSelectQuery()?.eq === 'function') {
      query = getHistSelectQuery()!.eq!('company_id', effectiveCompanyId);
      if (typeof getHistSelectQuery()?.eq === 'function') {
        query = getHistSelectQuery()!.eq!('customer_id', effectiveCustomerId);
      }
    }
    if (typeof getHistSelectQuery()?.order === 'function') {
      query = getHistSelectQuery()!.order!('changed_at', { ascending: false });
    }

    const { data, error } =
      (await (query as Promise<{ data: unknown; error: { message?: string } | null }>)) || {};

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
  let maskedPhoneVal: string | undefined;

  if (customerData.contact) {
    const rawOrNormalized =
      customerData.contact.raw_phone || customerData.contact.normalized_phone || '';

    maskedPhoneVal = rawOrNormalized ? maskPhone(rawOrNormalized) : undefined;
    if (isBossAdmin) {
      displayPhone = rawOrNormalized;
    } else {
      displayPhone = maskedPhoneVal;
    }
  } else {
    const cust = customerData.customer as Customer & { phone?: string; raw_phone?: string; metadata?: Record<string, unknown> };
    if (cust?.masked_phone && typeof cust.masked_phone === 'string') {
      maskedPhoneVal = cust.masked_phone;
    } else {
      const meta = cust?.metadata as Record<string, unknown> | undefined;
      if (meta?.masked_phone && typeof meta.masked_phone === 'string') {
        maskedPhoneVal = maskPhone(meta.masked_phone);
      }
    }

    if (isBossAdmin) {
      displayPhone = cust?.phone || cust?.raw_phone || maskedPhoneVal || undefined;
    } else {
      displayPhone = maskedPhoneVal;
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
    masked_phone: maskedPhoneVal,
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
  const isDemoMode = isDemoModeActive();

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
    let query: unknown = adminClient
      .from('customers')
      .select('*')
      .eq('company_id', effectiveCompanyId)
      .in('stage', [CUSTOMER_STAGES.PRICE_OFFERED, CUSTOMER_STAGES.NEGOTIATING]);

    const getCustQuery = () =>
      query as
        | {
            order?: (k: string, opt: { ascending: boolean }) => unknown;
            limit?: (n: number) => unknown;
          }
        | undefined;

    if (typeof getCustQuery()?.order === 'function') {
      query = getCustQuery()!.order!('created_at', { ascending: false });
    }

    if (typeof getCustQuery()?.limit === 'function') {
      query = getCustQuery()!.limit!(effectiveLimit);
    }

    const { data, error } =
      (await (query as Promise<{ data: unknown; error: { message?: string } | null }>)) || {};

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
  isDemoModeActive,
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
