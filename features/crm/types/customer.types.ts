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
 * Canonical Customer Journey Stages (FROZEN ARCHITECTURE)
 * Database check constraint on public.customers.stage
 */
export const CUSTOMER_STAGES = {
  // 12 Canonical Stages for Study Abroad Consulting (Tư vấn du học)
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
  CONTRACT_SIGNED: 'CONTRACT_SIGNED',
  CARE_NURTURING: 'CARE_NURTURING',

  // Legacy Door stages kept for DB backward compatibility
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

  // Business aliases
  KHACH_MOI: 'LEAD_NEW',
  LIEN_HE_LAN_1: 'CONTACT_CYCLE_1',
  LIEN_HE_LAN_2: 'CONTACT_CYCLE_2',
  LIEN_HE_LAN_3: 'CONTACT_CYCLE_3',
  KHONG_NGHE_MAY: 'UNREACHABLE',
  DA_KET_BAN_ZALO: 'ZALO_FRIENDED',
  DANG_CHAM_SOC: 'IN_CARE',
  CO_TIEM_NANG: 'POTENTIAL_CLOSING',
  CHUA_TIEM_NANG: 'NOT_POTENTIAL',
  KHONG_NHU_CAU: 'NO_DEMAND',
  DA_KY_HOP_DONG: 'CONTRACT_SIGNED',
  DA_KI_HOP_DONG: 'CONTRACT_SIGNED',
  CHAM_SOC_SAU_BAN: 'CARE_NURTURING',
  DA_CO_GIA: 'PRICE_OFFERED',
  DANG_THUONG_LUONG: 'NEGOTIATING',
} as const;

export type CustomerStage =
  | (typeof CUSTOMER_STAGES)[keyof typeof CUSTOMER_STAGES]
  | 'KHACH_MOI'
  | 'DA_CO_GIA'
  | 'DANG_THUONG_LUONG';

/**
 * Helper chuẩn hóa và kiểm thực danh mục giai đoạn khách hàng (Strict Runtime Allowlist)
 * Thắt chặt Runtime Allowlist - Lỗi P1 (Mục 12)
 */
export function toCanonicalStage(stage: unknown): CustomerStage {
  if (typeof stage !== 'string' || !stage.trim()) {
    throw new Error(`Giai đoạn khách hàng không hợp lệ: ${stage}`);
  }

  const upper = stage.trim().toUpperCase();

  // Hỗ trợ business alias sang canonical stage
  if (upper === 'KHACH_MOI') return CUSTOMER_STAGES.LEAD_NEW;
  if (upper === 'LIEN_HE_LAN_1') return CUSTOMER_STAGES.CONTACT_CYCLE_1;
  if (upper === 'LIEN_HE_LAN_2') return CUSTOMER_STAGES.CONTACT_CYCLE_2;
  if (upper === 'LIEN_HE_LAN_3') return CUSTOMER_STAGES.CONTACT_CYCLE_3;
  if (upper === 'KHONG_NGHE_MAY') return CUSTOMER_STAGES.UNREACHABLE;
  if (upper === 'DA_KET_BAN_ZALO') return CUSTOMER_STAGES.ZALO_FRIENDED;
  if (upper === 'DANG_CHAM_SOC') return CUSTOMER_STAGES.IN_CARE;
  if (upper === 'CO_TIEM_NANG') return CUSTOMER_STAGES.POTENTIAL_CLOSING;
  if (upper === 'CHUA_TIEM_NANG') return CUSTOMER_STAGES.NOT_POTENTIAL;
  if (upper === 'KHONG_NHU_CAU') return CUSTOMER_STAGES.NO_DEMAND;
  if (upper === 'DA_KY_HOP_DONG' || upper === 'DA_KI_HOP_DONG') return CUSTOMER_STAGES.CONTRACT_SIGNED;
  if (upper === 'CHAM_SOC_SAU_BAN') return CUSTOMER_STAGES.CARE_NURTURING;
  if (upper === 'DA_CO_GIA') return CUSTOMER_STAGES.PRICE_OFFERED;
  if (upper === 'DANG_THUONG_LUONG') return CUSTOMER_STAGES.NEGOTIATING;

  const validStages = Object.values(CUSTOMER_STAGES) as string[];
  if (validStages.includes(upper)) {
    return upper as CustomerStage;
  }

  if (upper in CUSTOMER_STAGES) {
    return (CUSTOMER_STAGES as Record<string, CustomerStage>)[upper];
  }

  throw new Error(`Giai đoạn khách hàng không hợp lệ: ${stage}`);
}

/**
 * Vietnamese human-readable labels for Customer Stages
 */
export const CUSTOMER_STAGE_LABELS: Record<string, string> = {
  // 12 Canonical Stages for Study Abroad Consulting
  LEAD_NEW: 'Khách mới',
  CONTACT_CYCLE_1: 'Liên hệ lần 1',
  CONTACT_CYCLE_2: 'Liên hệ lần 2',
  CONTACT_CYCLE_3: 'Liên hệ lần 3',
  UNREACHABLE: 'Không nghe máy',
  ZALO_FRIENDED: 'Đã kết bạn Zalo',
  IN_CARE: 'Đang chăm sóc',
  POTENTIAL_CLOSING: 'Có tiềm năng chốt đơn',
  NOT_POTENTIAL: 'Chưa có tiềm năng chốt đơn',
  NO_DEMAND: 'Không có nhu cầu nghe tư vấn',
  CONTRACT_SIGNED: 'Đã ký hợp đồng',
  CARE_NURTURING: 'Đang chăm sóc sau bán',

  // Legacy mappings for existing DB data
  SURVEY_REQUESTED: 'Đã kết bạn Zalo',
  SURVEY_SCHEDULED: 'Đang chăm sóc',
  SURVEY_COMPLETED: 'Đang chăm sóc',
  PRICE_CALCULATED: 'Có tiềm năng chốt đơn',
  NEED_INFO: 'Chưa có tiềm năng chốt đơn',
  PRICE_OFFERED: 'Có tiềm năng chốt đơn',
  NEGOTIATING: 'Có tiềm năng chốt đơn',
  ORDER_CREATED: 'Có tiềm năng chốt đơn',
  DEPOSIT_CONFIRMED: 'Đã ký hợp đồng',
  IN_PRODUCTION: 'Đang chăm sóc',
  READY_FOR_INSTALL: 'Đang chăm sóc',
  INSTALLING: 'Đang chăm sóc',
  HANDOVER_COMPLETED: 'Đang chăm sóc sau bán',
  WARRANTY_ACTIVE: 'Đang chăm sóc sau bán',
  LOST: 'Không có nhu cầu nghe tư vấn',

  // Business aliases
  KHACH_MOI: 'Khách mới',
  LIEN_HE_LAN_1: 'Liên hệ lần 1',
  LIEN_HE_LAN_2: 'Liên hệ lần 2',
  LIEN_HE_LAN_3: 'Liên hệ lần 3',
  KHONG_NGHE_MAY: 'Không nghe máy',
  DA_KET_BAN_ZALO: 'Đã kết bạn Zalo',
  DANG_CHAM_SOC: 'Đang chăm sóc',
  CO_TIEM_NANG: 'Có tiềm năng chốt đơn',
  CHUA_TIEM_NANG: 'Chưa có tiềm năng chốt đơn',
  KHONG_NHU_CAU: 'Không có nhu cầu nghe tư vấn',
  DA_KY_HOP_DONG: 'Đã ký hợp đồng',
  DA_KI_HOP_DONG: 'Đã ký hợp đồng',
  CHAM_SOC_SAU_BAN: 'Đang chăm sóc sau bán',
  DA_CO_GIA: 'Có tiềm năng chốt đơn',
  DANG_THUONG_LUONG: 'Có tiềm năng chốt đơn',
};

/**
 * Full Canonical Stage list with value and display label
 * Strictly covers 100% of canonical stages defined for Study Abroad Consulting.
 */
export const CANONICAL_STAGE_LIST: ReadonlyArray<{ value: CustomerStage; label: string }> = [
  { value: 'LEAD_NEW', label: 'Khách mới' },
  { value: 'CONTACT_CYCLE_1', label: 'Liên hệ lần 1' },
  { value: 'CONTACT_CYCLE_2', label: 'Liên hệ lần 2' },
  { value: 'CONTACT_CYCLE_3', label: 'Liên hệ lần 3' },
  { value: 'UNREACHABLE', label: 'Không nghe máy' },
  { value: 'ZALO_FRIENDED', label: 'Đã kết bạn Zalo' },
  { value: 'IN_CARE', label: 'Đang chăm sóc' },
  { value: 'POTENTIAL_CLOSING', label: 'Có tiềm năng chốt đơn' },
  { value: 'NOT_POTENTIAL', label: 'Chưa có tiềm năng chốt đơn' },
  { value: 'NO_DEMAND', label: 'Không có nhu cầu nghe tư vấn' },
  { value: 'CONTRACT_SIGNED', label: 'Đã ký hợp đồng' },
  { value: 'CARE_NURTURING', label: 'Đang chăm sóc sau bán' },
];

/**
 * Canonical Pipeline Stage Groups for CRM Dashboard
 * Direction A: Each group consists of explicit canonical customer stages (no subtractions, no guessing).
 */
export const PIPELINE_STAGE_GROUPS = {
  NEW_LEADS: [
    'LEAD_NEW',
    'CONTACT_CYCLE_1',
    'CONTACT_CYCLE_2',
    'CONTACT_CYCLE_3',
    'UNREACHABLE',
  ],
  SURVEY: [
    'ZALO_FRIENDED',
    'IN_CARE',
    'NOT_POTENTIAL',
    'SURVEY_REQUESTED',
    'SURVEY_SCHEDULED',
    'SURVEY_COMPLETED',
    'NEED_INFO',
  ],
  PRICING: [
    'POTENTIAL_CLOSING',
    'PRICE_CALCULATED',
    'PRICE_OFFERED',
    'NEGOTIATING',
  ],
  WON: [
    'CONTRACT_SIGNED',
    'CARE_NURTURING',
    'ORDER_CREATED',
    'DEPOSIT_CONFIRMED',
    'IN_PRODUCTION',
    'READY_FOR_INSTALL',
    'INSTALLING',
    'HANDOVER_COMPLETED',
    'WARRANTY_ACTIVE',
  ],
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
  phone?: string;
  is_phone_masked: boolean;
  identities?: Identity[];
  urgency_reason?: 'PRICE_OFFERED' | 'NEGOTIATING' | 'PENDING_REPLY' | string;
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
  actorType?: StageActorType;
  note?: string;
  userId?: string | null;
  actorId?: string | null;
  sourceRef?: string;
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
