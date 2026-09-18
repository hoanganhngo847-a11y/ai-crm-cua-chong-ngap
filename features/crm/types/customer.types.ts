/**
 * Customer and Identity types for CRM & Customer 360 module.
 *
 * Conforms strictly to:
 * - docs/PROJECT_MASTER.md (Sections 2, 4, 14, 15)
 * - docs/DATA_CONTRACT.md (Sections A, 4, 5, 6, 28)
 * - docs/SUPABASE_SCHEMA_DESIGN.md (Sections 3.4, 3.5, 3.6, 3.7, Schema Decisions 01, 03, 07)
 */

import type { ApplicationRole } from '../../../shared/constants/roles';

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
 * Isolated Customer Private Contact (private.customer_private_contacts)
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
  newStage: CustomerStage | string;
  actorType?: StageActorType;
  note?: string;
  userId?: string | null;
  companyId?: string;
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
  channel?: IdentityChannel;
  externalId?: string;
  metadata?: Record<string, unknown>;
  verified?: boolean;
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
