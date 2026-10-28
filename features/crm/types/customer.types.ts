/**
 * Customer and Identity types for CRM & Customer 360 module.
 *
 * Conforms strictly to:
 * - docs/PROJECT_MASTER.md (Sections 2, 4, 14, 15)
 * - docs/DATA_CONTRACT.md (Sections A, 4, 5, 6, 28)
 * - docs/SUPABASE_SCHEMA_DESIGN.md (Sections 3.4, 3.5, 3.6, 3.7, Schema Decisions 01, 03, 07)
 */

/**
 * Canonical Customer Acquisition Sources (FROZEN ARCHITECTURE)
 * Database check constraint: CHECK (source IN ('FACEBOOK', 'ZALO', 'ZALO_OA', 'WEBSITE', 'HOTLINE', 'ADVERTISING', 'MANUAL'))
 */
export const CUSTOMER_SOURCES = {
  FACEBOOK: 'FACEBOOK',
  ZALO: 'ZALO',
  ZALO_OA: 'ZALO_OA',
  WEBSITE: 'WEBSITE',
  HOTLINE: 'HOTLINE',
  ADVERTISING: 'ADVERTISING',
  MANUAL: 'MANUAL',
} as const;

export type CustomerSource = (typeof CUSTOMER_SOURCES)[keyof typeof CUSTOMER_SOURCES];

/**
 * Sáu giai đoạn chuẩn của phễu khách hàng.
 *
 * Mã nội bộ dùng chữ thường, ổn định và là nguồn duy nhất cho:
 * - CHECK constraint mới của public.customers.stage
 * - Kanban / Funnel
 * - AI stage suggestion
 *
 * Các giá trị legacy dạng CHỮ HOA vẫn được giữ trong DB để bảo toàn dữ liệu cũ
 * và để các tích hợp hiện hữu không bị vỡ trong thời gian chuyển đổi.
 */
export const CANONICAL_CUSTOMER_STAGES = [
  'awareness',
  'interested',
  'deep_research',
  'low_potential',
  'high_potential',
  'contract_signed',
] as const;

export type CanonicalCustomerStage = (typeof CANONICAL_CUSTOMER_STAGES)[number];

/**
 * Giá trị legacy còn tồn tại trong public.customers.stage.
 * Không xóa các giá trị này khỏi CHECK constraint cho đến khi có migration
 * chuẩn hóa và xác nhận thủ công.
 */
export const LEGACY_CUSTOMER_STAGES = [
  'LEAD_NEW',
  'CONTACT_CYCLE_1',
  'CONTACT_CYCLE_2',
  'CONTACT_CYCLE_3',
  'UNREACHABLE',
  'ZALO_FRIENDED',
  'IN_CARE',
  'POTENTIAL_CLOSING',
  'NOT_POTENTIAL',
  'NO_DEMAND',
  'CONTRACT_SIGNED',
  'CARE_NURTURING',
  'SURVEY_REQUESTED',
  'SURVEY_SCHEDULED',
  'SURVEY_COMPLETED',
  'PRICE_CALCULATED',
  'NEED_INFO',
  'PRICE_OFFERED',
  'NEGOTIATING',
  'ORDER_CREATED',
  'DEPOSIT_CONFIRMED',
  'IN_PRODUCTION',
  'READY_FOR_INSTALL',
  'INSTALLING',
  'HANDOVER_COMPLETED',
  'WARRANTY_ACTIVE',
  'LOST',
] as const;

export type LegacyCustomerStage = (typeof LEGACY_CUSTOMER_STAGES)[number];

export type CustomerStage = CanonicalCustomerStage | LegacyCustomerStage;

/**
 * Public stage constants.
 *
 * Các key canonical là nguồn chuẩn cho code mới. Các key legacy được giữ lại
 * để tương thích với module cũ và dữ liệu lịch sử.
 */
export const CUSTOMER_STAGES = {
  // Canonical six-stage funnel
  AWARENESS: 'awareness',
  INTERESTED: 'interested',
  DEEP_RESEARCH: 'deep_research',
  LOW_POTENTIAL: 'low_potential',
  HIGH_POTENTIAL: 'high_potential',
  CONTRACT_SIGNED: 'contract_signed',

  // Legacy study-abroad stages (kept for DB compatibility)
  LEAD_NEW: 'LEAD_NEW',
  CONTACT_CYCLE_1: 'CONTACT_CYCLE_1',
  CONTACT_CYCLE_2: 'CONTACT_CYCLE_2',
  CONTACT_CYCLE_3: 'CONTACT_CYCLE_3',
  UNREACHABLE: 'UNREACHABLE',
  ZALO_FRIENDED: 'ZALO_FRIENDED',
  IN_CARE: 'IN_CARE',
  POTENTIAL_CLOSING: 'POTENTIAL_CLOSING',
  NOT_POTENTIAL: 'NOT_POTENTIAL',
  NO_DEMAND: 'NO_DEMAND',
  LEGACY_CONTRACT_SIGNED: 'CONTRACT_SIGNED',
  CARE_NURTURING: 'CARE_NURTURING',

  // Legacy door/flood-barrier stages (kept for DB compatibility)
  SURVEY_REQUESTED: 'SURVEY_REQUESTED',
  SURVEY_SCHEDULED: 'SURVEY_SCHEDULED',
  SURVEY_COMPLETED: 'SURVEY_COMPLETED',
  PRICE_CALCULATED: 'PRICE_CALCULATED',
  NEED_INFO: 'NEED_INFO',
  PRICE_OFFERED: 'PRICE_OFFERED',
  NEGOTIATING: 'NEGOTIATING',
  ORDER_CREATED: 'ORDER_CREATED',
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',
  IN_PRODUCTION: 'IN_PRODUCTION',
  READY_FOR_INSTALL: 'READY_FOR_INSTALL',
  INSTALLING: 'INSTALLING',
  HANDOVER_COMPLETED: 'HANDOVER_COMPLETED',
  WARRANTY_ACTIVE: 'WARRANTY_ACTIVE',
  LOST: 'LOST',

  // Vietnamese business aliases (normalized to canonical values)
  KHACH_MOI: 'awareness',
  LIEN_HE_LAN_1: 'awareness',
  LIEN_HE_LAN_2: 'awareness',
  LIEN_HE_LAN_3: 'awareness',
  KHONG_NGHE_MAY: 'awareness',
  DA_KET_BAN_ZALO: 'awareness',
  DANG_CHAM_SOC: 'interested',
  CO_TIEM_NANG: 'high_potential',
  CHUA_TIEM_NANG: 'low_potential',
  KHONG_NHU_CAU: 'low_potential',
  DA_KY_HOP_DONG: 'contract_signed',
  DA_KI_HOP_DONG: 'contract_signed',
  CHAM_SOC_SAU_BAN: 'contract_signed',
  DA_CO_GIA: 'high_potential',
  DANG_THUONG_LUONG: 'high_potential',
} as const;

/**
 * Bảng ánh xạ legacy -> canonical dùng chung cho runtime.
 * Đây là ánh xạ HIỂN THỊ/TƯƠNG THÍCH, không phải bằng chứng nghiệp vụ.
 * Giá trị nào không có trong bảng này sẽ bị từ chối (fail-closed).
 */
export const LEGACY_STAGE_TO_CANONICAL: Record<string, CanonicalCustomerStage> = {
  AWARENESS: 'awareness',
  INTERESTED: 'interested',
  DEEP_RESEARCH: 'deep_research',
  LOW_POTENTIAL: 'low_potential',
  HIGH_POTENTIAL: 'high_potential',
  CONTRACT_SIGNED: 'contract_signed',

  LEAD_NEW: 'awareness',
  CONTACT_CYCLE_1: 'awareness',
  CONTACT_CYCLE_2: 'awareness',
  CONTACT_CYCLE_3: 'awareness',
  UNREACHABLE: 'awareness',
  ZALO_FRIENDED: 'awareness',
  KHACH_MOI: 'awareness',
  LIEN_HE_LAN_1: 'awareness',
  LIEN_HE_LAN_2: 'awareness',
  LIEN_HE_LAN_3: 'awareness',
  KHONG_NGHE_MAY: 'awareness',
  DA_KET_BAN_ZALO: 'awareness',

  IN_CARE: 'interested',
  DANG_CHAM_SOC: 'interested',
  SURVEY_REQUESTED: 'interested',
  SURVEY_SCHEDULED: 'interested',
  SURVEY_COMPLETED: 'interested',
  NEED_INFO: 'interested',

  POTENTIAL_CLOSING: 'high_potential',
  CO_TIEM_NANG: 'high_potential',
  NEGOTIATING: 'high_potential',
  DANG_THUONG_LUONG: 'high_potential',
  PRICE_CALCULATED: 'high_potential',
  PRICE_OFFERED: 'high_potential',
  DA_CO_GIA: 'high_potential',
  ORDER_CREATED: 'high_potential',
  DEPOSIT_CONFIRMED: 'high_potential',

  NOT_POTENTIAL: 'low_potential',
  CHUA_TIEM_NANG: 'low_potential',
  NO_DEMAND: 'low_potential',
  KHONG_NHU_CAU: 'low_potential',
  LOST: 'low_potential',

  CARE_NURTURING: 'contract_signed',
  CHAM_SOC_SAU_BAN: 'contract_signed',
  DA_KY_HOP_DONG: 'contract_signed',
  DA_KI_HOP_DONG: 'contract_signed',
  IN_PRODUCTION: 'contract_signed',
  READY_FOR_INSTALL: 'contract_signed',
  INSTALLING: 'contract_signed',
  HANDOVER_COMPLETED: 'contract_signed',
  WARRANTY_ACTIVE: 'contract_signed',
};

/**
 * Các giá trị legacy được migration tự động chuyển sang canonical vì
 * ý nghĩa nghiệp vụ đủ rõ ràng.
 *
 * Các giá trị legacy KHÔNG nằm trong danh sách này sẽ được giữ nguyên
 * và đưa vào danh sách "cần rà soát" (xem STAGE_REVIEW_VALUES).
 */
export const SAFE_MIGRATION_STAGE_MAP: Record<string, CanonicalCustomerStage> = {
  LEAD_NEW: 'awareness',
  CONTACT_CYCLE_1: 'awareness',
  CONTACT_CYCLE_2: 'awareness',
  CONTACT_CYCLE_3: 'awareness',
  UNREACHABLE: 'awareness',
  ZALO_FRIENDED: 'awareness',
  IN_CARE: 'interested',
  POTENTIAL_CLOSING: 'high_potential',
  NEGOTIATING: 'high_potential',
  ORDER_CREATED: 'high_potential',
  DEPOSIT_CONFIRMED: 'high_potential',
  NOT_POTENTIAL: 'low_potential',
  NO_DEMAND: 'low_potential',
  LOST: 'low_potential',
  CONTRACT_SIGNED: 'contract_signed',
};

/**
 * Legacy values intentionally left untouched by the automatic migration.
 * They remain visible and are counted as "cần rà soát".
 */
export const STAGE_REVIEW_VALUES: ReadonlyArray<LegacyCustomerStage> = [
  'SURVEY_REQUESTED',
  'SURVEY_SCHEDULED',
  'SURVEY_COMPLETED',
  'PRICE_CALCULATED',
  'NEED_INFO',
  'PRICE_OFFERED',
  'CARE_NURTURING',
  'IN_PRODUCTION',
  'READY_FOR_INSTALL',
  'INSTALLING',
  'HANDOVER_COMPLETED',
  'WARRANTY_ACTIVE',
];

const CANONICAL_STAGE_SET = new Set<string>(CANONICAL_CUSTOMER_STAGES);
const LEGACY_STAGE_SET = new Set<string>(LEGACY_CUSTOMER_STAGES);

export function isCanonicalCustomerStage(value: unknown): value is CanonicalCustomerStage {
  return typeof value === 'string' && CANONICAL_STAGE_SET.has(value);
}

export function isLegacyCustomerStage(value: unknown): value is LegacyCustomerStage {
  return typeof value === 'string' && LEGACY_STAGE_SET.has(value);
}

/**
 * Chuẩn hóa bất kỳ giá trị giai đoạn hợp lệ nào về một trong 6 mã canonical.
 * Ném lỗi với giá trị rỗng/không xác định (fail-closed).
 */
export function toCanonicalStage(stage: unknown): CanonicalCustomerStage {
  if (typeof stage !== 'string' || !stage.trim()) {
    throw new Error(`Giai đoạn khách hàng không hợp lệ: ${String(stage)}`);
  }

  const trimmed = stage.trim();
  if (isCanonicalCustomerStage(trimmed)) {
    return trimmed;
  }

  const upper = trimmed.toUpperCase();
  const mapped = LEGACY_STAGE_TO_CANONICAL[upper];
  if (mapped) {
    return mapped;
  }

  throw new Error(`Giai đoạn khách hàng không hợp lệ: ${stage}`);
}

/**
 * Phiên bản không ném lỗi, dùng cho dữ liệu legacy chưa xác định.
 */
export function tryToCanonicalStage(stage: unknown): CanonicalCustomerStage | null {
  try {
    return toCanonicalStage(stage);
  } catch {
    return null;
  }
}

/**
 * Giá trị cần rà soát: legacy còn trong DB hoặc không nhận diện được.
 */
export function stageNeedsReview(stage: unknown): boolean {
  if (typeof stage !== 'string' || !stage.trim()) {
    return true;
  }
  return !isCanonicalCustomerStage(stage.trim());
}

/**
 * Vietnamese human-readable labels for canonical and legacy Customer Stages.
 */
export const CUSTOMER_STAGE_LABELS: Record<string, string> = {
  // Canonical six-stage funnel
  awareness: 'Nhận biết',
  interested: 'Quan tâm',
  deep_research: 'Tìm hiểu sâu',
  low_potential: 'Ít tiềm năng',
  high_potential: 'Có tiềm năng',
  contract_signed: 'Đã ký hợp đồng',

  // Legacy study-abroad stages
  LEAD_NEW: 'Nhận biết (dữ liệu cũ)',
  CONTACT_CYCLE_1: 'Nhận biết (dữ liệu cũ)',
  CONTACT_CYCLE_2: 'Nhận biết (dữ liệu cũ)',
  CONTACT_CYCLE_3: 'Nhận biết (dữ liệu cũ)',
  UNREACHABLE: 'Nhận biết (dữ liệu cũ)',
  ZALO_FRIENDED: 'Nhận biết (dữ liệu cũ)',
  IN_CARE: 'Quan tâm (dữ liệu cũ)',
  POTENTIAL_CLOSING: 'Có tiềm năng (dữ liệu cũ)',
  NOT_POTENTIAL: 'Ít tiềm năng (dữ liệu cũ)',
  NO_DEMAND: 'Ít tiềm năng (dữ liệu cũ)',
  CONTRACT_SIGNED: 'Đã ký hợp đồng (dữ liệu cũ)',
  CARE_NURTURING: 'Đã ký hợp đồng (cần rà soát)',

  // Legacy door/flood-barrier stages
  SURVEY_REQUESTED: 'Quan tâm (cần rà soát)',
  SURVEY_SCHEDULED: 'Quan tâm (cần rà soát)',
  SURVEY_COMPLETED: 'Quan tâm (cần rà soát)',
  PRICE_CALCULATED: 'Có tiềm năng (cần rà soát)',
  NEED_INFO: 'Quan tâm (cần rà soát)',
  PRICE_OFFERED: 'Có tiềm năng (cần rà soát)',
  NEGOTIATING: 'Có tiềm năng (dữ liệu cũ)',
  ORDER_CREATED: 'Có tiềm năng (dữ liệu cũ)',
  DEPOSIT_CONFIRMED: 'Có tiềm năng (dữ liệu cũ)',
  IN_PRODUCTION: 'Đã ký hợp đồng (cần rà soát)',
  READY_FOR_INSTALL: 'Đã ký hợp đồng (cần rà soát)',
  INSTALLING: 'Đã ký hợp đồng (cần rà soát)',
  HANDOVER_COMPLETED: 'Đã ký hợp đồng (cần rà soát)',
  WARRANTY_ACTIVE: 'Đã ký hợp đồng (cần rà soát)',
  LOST: 'Ít tiềm năng (dữ liệu cũ)',

  // Business aliases
  KHACH_MOI: 'Nhận biết',
  LIEN_HE_LAN_1: 'Nhận biết',
  LIEN_HE_LAN_2: 'Nhận biết',
  LIEN_HE_LAN_3: 'Nhận biết',
  KHONG_NGHE_MAY: 'Nhận biết',
  DA_KET_BAN_ZALO: 'Nhận biết',
  DANG_CHAM_SOC: 'Quan tâm',
  CO_TIEM_NANG: 'Có tiềm năng',
  CHUA_TIEM_NANG: 'Ít tiềm năng',
  KHONG_NHU_CAU: 'Ít tiềm năng',
  DA_KY_HOP_DONG: 'Đã ký hợp đồng',
  DA_KI_HOP_DONG: 'Đã ký hợp đồng',
  CHAM_SOC_SAU_BAN: 'Đã ký hợp đồng',
  DA_CO_GIA: 'Có tiềm năng',
  DANG_THUONG_LUONG: 'Có tiềm năng',
};

/**
 * Full Canonical Stage list with value, label and business meaning.
 * Thứ tự này là thứ tự cột Kanban và thứ tự thanh Funnel.
 */
export const CANONICAL_STAGE_LIST: ReadonlyArray<{
  value: CanonicalCustomerStage;
  label: string;
  description: string;
}> = [
  {
    value: 'awareness',
    label: 'Nhận biết',
    description: 'Khách mới tiếp xúc, chưa có nhu cầu cụ thể rõ ràng.',
  },
  {
    value: 'interested',
    label: 'Quan tâm',
    description: 'Khách bắt đầu hỏi về sản phẩm, giá, tính năng hoặc dịch vụ.',
  },
  {
    value: 'deep_research',
    label: 'Tìm hiểu sâu',
    description: 'Khách so sánh, yêu cầu chi tiết, kiểm tra điều kiện hoặc đánh giá phương án.',
  },
  {
    value: 'low_potential',
    label: 'Ít tiềm năng',
    description: 'Chưa có nhu cầu phù hợp, thiếu điều kiện hoặc chưa có kế hoạch hiện tại.',
  },
  {
    value: 'high_potential',
    label: 'Có tiềm năng',
    description: 'Có nhu cầu thực tế, khả năng mua hoặc bước tiếp theo tương đối rõ ràng.',
  },
  {
    value: 'contract_signed',
    label: 'Đã ký hợp đồng',
    description: 'Có bằng chứng đáng tin cậy xác nhận hợp đồng với doanh nghiệp đã được ký.',
  },
];

export const CANONICAL_STAGE_ORDER: ReadonlyArray<CanonicalCustomerStage> =
  CANONICAL_CUSTOMER_STAGES;

/**
 * Tất cả giá trị DB (canonical + legacy) thuộc về một giai đoạn canonical.
 * Dùng cho bộ lọc `.in('stage', ...)` để không bỏ sót dữ liệu legacy.
 */
export const DB_STAGE_VALUES_BY_CANONICAL: Record<CanonicalCustomerStage, CustomerStage[]> = {
  awareness: ['awareness', 'LEAD_NEW', 'CONTACT_CYCLE_1', 'CONTACT_CYCLE_2', 'CONTACT_CYCLE_3', 'UNREACHABLE', 'ZALO_FRIENDED'],
  interested: ['interested', 'IN_CARE', 'SURVEY_REQUESTED', 'SURVEY_SCHEDULED', 'SURVEY_COMPLETED', 'NEED_INFO'],
  deep_research: ['deep_research'],
  low_potential: ['low_potential', 'NOT_POTENTIAL', 'NO_DEMAND', 'LOST'],
  high_potential: ['high_potential', 'POTENTIAL_CLOSING', 'NEGOTIATING', 'PRICE_CALCULATED', 'PRICE_OFFERED', 'ORDER_CREATED', 'DEPOSIT_CONFIRMED'],
  contract_signed: ['contract_signed', 'CONTRACT_SIGNED', 'CARE_NURTURING', 'IN_PRODUCTION', 'READY_FOR_INSTALL', 'INSTALLING', 'HANDOVER_COMPLETED', 'WARRANTY_ACTIVE'],
};

/**
 * Canonical Pipeline Stage Groups for CRM Dashboard.
 *
 * Mỗi nhóm chứa TOÀN BỘ giá trị DB (canonical + legacy) để phép đếm
 * không bỏ sót khách hàng cũ. Các key NEW_LEADS/SURVEY/PRICING/WON được
 * giữ như alias tương thích cho dashboard hiện tại.
 */
export const PIPELINE_STAGE_GROUPS = {
  AWARENESS: DB_STAGE_VALUES_BY_CANONICAL.awareness,
  INTERESTED: DB_STAGE_VALUES_BY_CANONICAL.interested,
  DEEP_RESEARCH: DB_STAGE_VALUES_BY_CANONICAL.deep_research,
  LOW_POTENTIAL: DB_STAGE_VALUES_BY_CANONICAL.low_potential,
  HIGH_POTENTIAL: DB_STAGE_VALUES_BY_CANONICAL.high_potential,
  CONTRACT_SIGNED: DB_STAGE_VALUES_BY_CANONICAL.contract_signed,

  // Backward-compatible aliases
  NEW_LEADS: DB_STAGE_VALUES_BY_CANONICAL.awareness,
  SURVEY: [...DB_STAGE_VALUES_BY_CANONICAL.interested, ...DB_STAGE_VALUES_BY_CANONICAL.deep_research],
  PRICING: DB_STAGE_VALUES_BY_CANONICAL.high_potential,
  WON: DB_STAGE_VALUES_BY_CANONICAL.contract_signed,
} as const;

/**
 * Identity Channels (public.identities.channel)
 * Database check constraint: CHECK (channel IN ('ZALO', 'FACEBOOK', 'WEBSITE', 'PHONE'))
 */
export const IDENTITY_CHANNELS = {
  ZALO: 'ZALO',
  FACEBOOK: 'FACEBOOK',
  WEBSITE: 'WEBSITE',
  PHONE: 'PHONE',
} as const;

export type IdentityChannel = (typeof IDENTITY_CHANNELS)[keyof typeof IDENTITY_CHANNELS];

/**
 * Stage History Actor Types
 */
export const STAGE_ACTOR_TYPES = {
  USER: 'USER',
  AI: 'AI',
  SYSTEM: 'SYSTEM',
} as const;

export type StageActorType = (typeof STAGE_ACTOR_TYPES)[keyof typeof STAGE_ACTOR_TYPES];

export const STAGE_VERIFICATION_STATUSES = {
  UNVERIFIED: 'UNVERIFIED',
  AI_SUGGESTED: 'AI_SUGGESTED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;

export type StageVerificationStatus =
  (typeof STAGE_VERIFICATION_STATUSES)[keyof typeof STAGE_VERIFICATION_STATUSES];

// ============================================================================
// Database Entities
// ============================================================================

/**
 * Central Customer entity (public.customers)
 * ZERO-PHONE INVARIANT: No phone, raw_phone, or normalized_phone column.
 */
export interface Customer {
  id: string;
  company_id: string;
  customer_code: string;
  name: string;
  source: CustomerSource;
  stage: CustomerStage;
  created_at: string;
  updated_at: string;
}

/**
 * Isolated Customer Private Contact (in private schema)
 * Accessible ONLY by trusted server operations / RPC.
 */
export interface CustomerPrivateContact {
  id: string;
  company_id: string;
  customer_id: string;
  normalized_phone: string;
  raw_phone: string;
  phone_country_code: string;
  is_verified: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Multi-channel Identity entity (public.identities)
 * For channel = 'PHONE', external_id MUST be Keyed HMAC-SHA256 (64 hex characters).
 */
export interface Identity {
  id: string;
  company_id: string;
  customer_id: string;
  channel: IdentityChannel;
  external_id: string;
  verified: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Append-only Customer Stage History (public.customer_stage_histories)
 */
export interface CustomerStageHistory {
  id: string;
  company_id: string;
  customer_id: string;
  from_stage: CustomerStage | null;
  to_stage: CustomerStage;
  actor_type: StageActorType;
  changed_by_user_id: string | null;
  actor_id?: string | null;
  reason: string;
  note?: string;
  source_ref: string | null;
  evidence?: string | null;
  confidence?: number | null;
  verification_status?: StageVerificationStatus | null;
  changed_at: string;
  created_at?: string;
}

// ============================================================================
// Service & API Data Transfer Objects (DTOs)
// ============================================================================

/**
 * Internal bundle combining Customer profile and secure contact details.
 * Strictly server-side only.
 */
export interface CustomerWithContact {
  customer: Customer;
  contact?: {
    raw_phone?: string;
    normalized_phone?: string;
    is_verified?: boolean;
  } | null;
  identities?: Identity[];
}

/**
 * Role-sanitized Customer payload safe for client-side transmission.
 * - SALE: receives masked phone (e.g., '09******12'), is_phone_masked = true.
 * - BOSS_ADMIN: receives full phone, is_phone_masked = false.
 * - Invariant: NEVER leaks raw_phone or normalized_phone as dedicated unmasked fields to SALE.
 */
export interface CustomerResponse {
  id: string;
  company_id: string;
  customer_code: string;
  name: string;
  source: CustomerSource;
  stage: CustomerStage;
  canonical_stage?: CanonicalCustomerStage;
  stage_needs_review?: boolean;
  phone?: string;
  is_phone_masked: boolean;
  identities?: Identity[];
  urgency_reason?: 'HIGH_POTENTIAL' | 'PRICE_OFFERED' | 'NEGOTIATING' | 'PENDING_REPLY' | string;
  urgency_label?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Parameters for updating customer stage and recording immutable history.
 */
export interface UpdateCustomerStageParams {
  customerId: string;
  companyId: string;
  newStage?: CustomerStage | string;
  to_stage?: CustomerStage | string; // Business alias for newStage
  expectedStage?: CustomerStage | string | null;
  actorType?: StageActorType;
  note?: string;
  userId?: string | null;
  actorId?: string | null;
  sourceRef?: string;
  evidence?: string;
  confidence?: number;
  verificationStatus?: StageVerificationStatus;
}

/**
 * Parameters for finding or creating a customer by phone.
 */
export interface FindOrCreateCustomerParams {
  companyId: string;
  phone: string;
  name: string;
  source?: CustomerSource;
  stage?: CustomerStage;
  note?: string;
  channel?: IdentityChannel;
  externalId?: string;
  metadata?: Record<string, unknown>;
  verified?: boolean;
  /**
   * SERVER AUTHORITY (Lỗi P1 - Mục 9):
   * Chỉ có Webhook từ provider (hoặc quy trình xác thực OTP / trusted server)
   * có bằng chứng xác thực mới được phép gán true. Luồng thủ công từ client mặc định là false.
   */
  isTrustedProvider?: boolean;
  actorUserId?: string;
}

/**
 * Result of findOrCreateByPhone operation.
 */
export interface FindOrCreateCustomerResult {
  customer: Customer;
  contact: {
    raw_phone: string;
    normalized_phone: string;
    is_verified: boolean;
  };
  identities: Identity[];
  isNew: boolean;
}

/**
 * Query parameters for filtering and paginating customers.
 */
export interface CustomerListQuery {
  companyId: string;
  search?: string;
  stage?: CustomerStage;
  source?: CustomerSource;
  limit?: number;
  offset?: number;
}

/**
 * Paginated list response for customers.
 */
export interface CustomerListResponse {
  data: CustomerResponse[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}

// ============================================================================
// Pipeline / Funnel DTOs
// ============================================================================

export interface CustomerPipelineStageCount {
  stage: CanonicalCustomerStage;
  label: string;
  count: number;
  percentage: number;
  needs_review_count: number;
}

export interface CustomerPipelineFilters {
  search: string;
  source: CustomerSource | null;
  from: string | null;
  to: string | null;
  stage: CanonicalCustomerStage | null;
}

export interface CustomerPipelineResponse {
  stages: CustomerPipelineStageCount[];
  customers: CustomerResponse[];
  total: number;
  total_customers: number;
  eligible_customers: number;
  unmapped_count: number;
  needs_review_count: number;
  truncated: boolean;
  filters: CustomerPipelineFilters;
}

export interface CustomerStageSuggestionEvidence {
  quote: string;
  source: string;
  occurredAt: string | null;
  speaker: 'CUSTOMER' | 'STAFF' | 'UNKNOWN';
  signal?: string | null;
  stage?: CanonicalCustomerStage | null;
  weight?: number | null;
}

export interface CustomerStageSuggestion {
  id: string;
  company_id: string;
  customer_id: string;
  summary: string;
  stage_suggestion: CanonicalCustomerStage | null;
  current_stage: CanonicalCustomerStage | null;
  confidence: number;
  evidence: string;
  evidence_items: CustomerStageSuggestionEvidence[];
  reason: string | null;
  stop_reason: string | null;
  objections: string[];
  next_action: string | null;
  requires_verification: boolean;
  verification_status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'NOT_REQUIRED';
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  classifier_version: string | null;
  model_version: string;
  created_at: string;
}
