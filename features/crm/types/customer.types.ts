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
  LEAD_NEW: 'LEAD_NEW',
  KHACH_MOI: 'LEAD_NEW', // Business alias for LEAD_NEW
  DA_CO_GIA: 'PRICE_OFFERED', // Business alias for PRICE_OFFERED (Cần Sale chốt)
  DANG_THUONG_LUONG: 'NEGOTIATING', // Business alias for NEGOTIATING (Cần Sale chốt)
  CONTACT_CYCLE_1: 'CONTACT_CYCLE_1',
  CONTACT_CYCLE_2: 'CONTACT_CYCLE_2',
  CONTACT_CYCLE_3: 'CONTACT_CYCLE_3',
  UNREACHABLE: 'UNREACHABLE',
  SURVEY_REQUESTED: 'SURVEY_REQUESTED',
  SURVEY_SCHEDULED: 'SURVEY_SCHEDULED',
  SURVEY_COMPLETED: 'SURVEY_COMPLETED',
  PRICE_CALCULATED: 'PRICE_CALCULATED',
  NEED_INFO: 'NEED_INFO',
  PRICE_OFFERED: 'PRICE_OFFERED',
  NEGOTIATING: 'NEGOTIATING',
  ORDER_CREATED: 'ORDER_CREATED',
  DEPOSIT_CONFIRMED: 'DEPOSIT_CONFIRMED',
  CONTRACT_SIGNED: 'CONTRACT_SIGNED',
  IN_PRODUCTION: 'IN_PRODUCTION',
  READY_FOR_INSTALL: 'READY_FOR_INSTALL',
  INSTALLING: 'INSTALLING',
  HANDOVER_COMPLETED: 'HANDOVER_COMPLETED',
  WARRANTY_ACTIVE: 'WARRANTY_ACTIVE',
  LOST: 'LOST',
  CARE_NURTURING: 'CARE_NURTURING',
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
  LEAD_NEW: 'Khách mới',
  CONTACT_CYCLE_1: 'Liên hệ lần 1',
  CONTACT_CYCLE_2: 'Liên hệ lần 2',
  CONTACT_CYCLE_3: 'Liên hệ lần 3',
  UNREACHABLE: 'Không nghe máy',
  SURVEY_REQUESTED: 'Yêu cầu khảo sát',
  SURVEY_SCHEDULED: 'Đã hẹn khảo sát',
  SURVEY_COMPLETED: 'Đã khảo sát hiện trường',
  PRICE_CALCULATED: 'Đã lên giá / tính giá',
  NEED_INFO: 'Cần bổ sung thông tin',
  PRICE_OFFERED: 'Đã báo giá phương án',
  NEGOTIATING: 'Đang đàm phán chốt giá',
  ORDER_CREATED: 'Đã tạo đơn hàng',
  DEPOSIT_CONFIRMED: 'Đã đặt cọc',
  CONTRACT_SIGNED: 'Đã ký hợp đồng',
  IN_PRODUCTION: 'Đang sản xuất',
  READY_FOR_INSTALL: 'Sẵn sàng lắp đặt',
  INSTALLING: 'Đang thi công lắp đặt',
  HANDOVER_COMPLETED: 'Hoàn tất bàn giao',
  WARRANTY_ACTIVE: 'Đang bảo hành',
  LOST: 'Mất khách / Đã hủy',
  CARE_NURTURING: 'Đang chăm sóc sau bán',
  // Business Aliases
  KHACH_MOI: 'Khách mới',
  DA_CO_GIA: 'Đã báo giá phương án',
  DANG_THUONG_LUONG: 'Đang đàm phán chốt giá',
};

/**
 * Full Canonical Stage list with value and display label
 * Strictly covers 100% of canonical stages defined in the DB schema check constraint.
 */
export const CANONICAL_STAGE_LIST: ReadonlyArray<{ value: CustomerStage; label: string }> = [
  { value: 'LEAD_NEW', label: 'Khách mới' },
  { value: 'CONTACT_CYCLE_1', label: 'Liên hệ lần 1' },
  { value: 'CONTACT_CYCLE_2', label: 'Liên hệ lần 2' },
  { value: 'CONTACT_CYCLE_3', label: 'Liên hệ lần 3' },
  { value: 'UNREACHABLE', label: 'Không nghe máy' },
  { value: 'SURVEY_REQUESTED', label: 'Yêu cầu khảo sát' },
  { value: 'SURVEY_SCHEDULED', label: 'Đã hẹn khảo sát' },
  { value: 'SURVEY_COMPLETED', label: 'Đã khảo sát hiện trường' },
  { value: 'PRICE_CALCULATED', label: 'Đã lên giá / tính giá' },
  { value: 'NEED_INFO', label: 'Cần bổ sung thông tin' },
  { value: 'PRICE_OFFERED', label: 'Đã báo giá phương án' },
  { value: 'NEGOTIATING', label: 'Đang đàm phán chốt giá' },
  { value: 'ORDER_CREATED', label: 'Đã tạo đơn hàng' },
  { value: 'DEPOSIT_CONFIRMED', label: 'Đã đặt cọc' },
  { value: 'CONTRACT_SIGNED', label: 'Đã ký hợp đồng' },
  { value: 'IN_PRODUCTION', label: 'Đang sản xuất' },
  { value: 'READY_FOR_INSTALL', label: 'Sẵn sàng lắp đặt' },
  { value: 'INSTALLING', label: 'Đang thi công lắp đặt' },
  { value: 'HANDOVER_COMPLETED', label: 'Hoàn tất bàn giao' },
  { value: 'WARRANTY_ACTIVE', label: 'Đang bảo hành' },
  { value: 'LOST', label: 'Mất khách / Đã hủy' },
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
    'SURVEY_REQUESTED',
    'SURVEY_SCHEDULED',
    'SURVEY_COMPLETED',
    'NEED_INFO',
  ],
  PRICING: [
    'PRICE_CALCULATED',
    'PRICE_OFFERED',
    'NEGOTIATING',
  ],
  WON: [
    'ORDER_CREATED',
    'DEPOSIT_CONFIRMED',
    'CONTRACT_SIGNED',
    'IN_PRODUCTION',
    'READY_FOR_INSTALL',
    'INSTALLING',
    'HANDOVER_COMPLETED',
    'WARRANTY_ACTIVE',
    'CARE_NURTURING',
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
