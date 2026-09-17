/**
 * Webhook Ingress Types for Omnichannel Inbound Events (Phase 3 Ready).
 *
 * Conforms to:
 * - docs/PROJECT_MASTER.md (Section 7: 5-minute rule, Section 14, Section 17, Section 21)
 * - docs/DATA_CONTRACT.md (Section 7: Interaction, Section 8: Conversation)
 * - docs/SUPABASE_RLS_DESIGN.md (Section 21: Webhook and Provider Paths - Service Role Context B)
 */

import type { InboxChannel } from './inbox.types';

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
