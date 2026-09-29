/**
 * Webhook Ingress Types for Omnichannel Inbound Events (Phase 3 Ready).
 *
 * Conforms to:
 * - docs/PROJECT_MASTER.md (Section 7: 5-minute rule, Section 14, Section 17, Section 21)
 * - docs/DATA_CONTRACT.md (Section 7: Interaction, Section 8: Conversation)
 * - docs/SUPABASE_RLS_DESIGN.md (Section 21: Webhook and Provider Paths - Service Role Context B)
 */

import type { InboxChannel } from './inbox.types';

export const INGRESS_PROVIDERS = {
  FACEBOOK: 'FACEBOOK',
  ZALO: 'ZALO',
  SYSTEM: 'SYSTEM',
} as const;

export type IngressProvider = (typeof INGRESS_PROVIDERS)[keyof typeof INGRESS_PROVIDERS];

export const WEBHOOK_EVENT_TYPES = {
  MESSAGE_CREATED: 'message.created',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  USER_FOLLOW: 'user.follow',
} as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[keyof typeof WEBHOOK_EVENT_TYPES];

export interface InboundSenderInfo {
  id: string; // External provider user ID (Zalo UID, Facebook PSID)
  name?: string;
  phone?: string;
  avatar_url?: string;
  customer_id?: string;
}

export interface InboundMessageAttachment {
  type: 'image' | 'file' | 'audio' | 'video' | 'location';
  url: string;
  title?: string;
}

export interface InboundMessageData {
  id: string; // Provider message ID
  text: string;
  timestamp: string; // ISO 8601 string
  attachments?: InboundMessageAttachment[];
}

/**
 * Standardized Ingress Payload from external channels (Zalo OA, Facebook Messenger)
 */
export interface OmnichannelWebhookPayload {
  event_id: string; // Unique event ID for idempotency & replay protection
  channel: InboxChannel;
  event_type: WebhookEventType;
  company_id?: string;
  sender: InboundSenderInfo;
  recipient?: {
    id: string;
    name?: string;
  };
  message: InboundMessageData;
  metadata?: Record<string, unknown>;
}

/**
 * Normalized Ingress Event Contract owned by Member 2.
 * Clean, decoupled interface for Member 3 (Zalo OA) & Member 4 (Facebook Messenger).
 */
export interface NormalizedIngressEvent {
  provider: 'FACEBOOK' | 'ZALO' | 'SYSTEM';
  company_id: string; // MANDATORY - Strict Tenant Isolation
  external_user_id: string;
  sender_name?: string;
  sender_phone?: string;
  message_id: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result of processing an incoming webhook event
 */
export interface IngressProcessResult {
  success: boolean;
  duplicate?: boolean;
  conversation_id?: string;
  message_id?: string;
  customer_id?: string;
  customer_name?: string;
  channel?: InboxChannel;
  is_new_conversation?: boolean;
  error?: string;
}

/**
 * Result of webhook cryptographic signature verification
 */
export interface WebhookVerificationResult {
  valid: boolean;
  reason?: string;
}

// ============================================================================
// ARCHITECTURAL BOUNDARIES (Lỗi P1 - Mục 15):
// - Member 2: Chủ quản NormalizedIngressEvent & Core Ingestion Engine (InboxIngressService.ingestNormalizedEvent)
// - Member 3: Chủ quản Zalo OA Adapter (ZaloWebhookEnvelope & ZaloAdapter)
// - Member 4: Chủ quản Facebook Messenger Adapter (FacebookWebhookEnvelope & FacebookAdapter)
// ============================================================================

/**
 * Facebook Webhook Raw Envelope (Member 4 ownership boundary)
 */
export interface FacebookWebhookEnvelope {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<{
      sender?: { id: string; name?: string };
      recipient?: { id: string };
      timestamp?: number;
      message?: {
        mid: string;
        text?: string;
        attachments?: unknown[];
      };
    }>;
  }>;
  recipient?: { id: string };
  page_id?: string;
  [key: string]: unknown;
}

/**
 * Zalo OA Webhook Raw Envelope (Member 3 ownership boundary)
 */
export interface ZaloWebhookEnvelope {
  event_name?: string;
  app_id?: string;
  oa_id?: string;
  timestamp?: number | string;
  user_id_by_app?: string;
  sender?: {
    id: string;
    name?: string;
    phone?: string;
  };
  recipient?: {
    id: string;
  };
  message?: {
    msg_id?: string;
    text?: string;
    attachments?: unknown[];
  };
  msg_id?: string;
  [key: string]: unknown;
}

/**
 * Canonical Provider Adapter Port (Owned by Member 2).
 * Contract definition for external provider adapters (Member 3 - Zalo, Member 4 - Facebook).
 *
 * Architectural Boundary:
 * - Member 2: Owns Ingress Engine, Webhook Gateway Dispatcher, and Port Interface.
 * - Member 3: Owns Zalo OA Integration & supplies official ZaloAdapter.
 * - Member 4: Owns Facebook Messenger Integration & supplies official FacebookAdapter.
 */
export interface ProviderAdapterPort<TEnvelope = unknown> {
  provider: IngressProvider;
  verifySignature(
    rawPayload: string,
    headers: Record<string, string>
  ): Promise<WebhookVerificationResult>;
  deriveTenant(envelope: TEnvelope): Promise<string>;
  parseToNormalized(
    envelope: TEnvelope,
    companyId: string
  ): Promise<NormalizedIngressEvent[]>;
}

/**
 * Backward-compatible contract for Provider Handlers
 */
export interface ProviderWebhookAdapter<T = unknown> {
  provider: IngressProvider;
  verifySignature(
    rawBody: string,
    signatureOrHeaders: unknown,
    secret?: string | null | undefined
  ): WebhookVerificationResult | Promise<WebhookVerificationResult>;
  deriveTenant(payload: T | string): string | null | Promise<string>;
  parseToNormalized(
    payload: T,
    resolvedCompanyId: string
  ): NormalizedIngressEvent | Promise<NormalizedIngressEvent[]>;
}

/**
 * Provider Adapter Registry (Gateway Dispatcher Registry).
 * Maps provider channels (FACEBOOK, ZALO, SYSTEM) to their corresponding ProviderAdapterPort.
 *
 * Architectural Boundaries:
 * - Member 2: Owns the Ingress Engine, Webhook Gateway Dispatcher, and Port Interface.
 * - Member 3: Implements and supplies ZaloAdapter (Zalo OA).
 * - Member 4: Implements and supplies FacebookAdapter (Facebook Messenger).
 */
export class ProviderAdapterRegistry {
  private static adapters = new Map<string, ProviderAdapterPort<unknown>>();

  public static register<T>(provider: IngressProvider | string, adapter: ProviderAdapterPort<T>): void {
    this.adapters.set(provider.toUpperCase(), adapter as ProviderAdapterPort<unknown>);
  }

  public static get<T = unknown>(provider: IngressProvider | string): ProviderAdapterPort<T> | undefined {
    return this.adapters.get(provider.toUpperCase()) as ProviderAdapterPort<T> | undefined;
  }

  public static has(provider: IngressProvider | string): boolean {
    return this.adapters.has(provider.toUpperCase());
  }

  public static clear(): void {
    this.adapters.clear();
  }

  public static getAll(): Map<string, ProviderAdapterPort<unknown>> {
    return new Map(this.adapters);
  }
}
