/**
 * Inbox and Conversation Types for Omnichannel Inbox Module.
 *
 * Conforms strictly to:
 * - docs/PROJECT_MASTER.md (Sections 3, 7, 8, 14, 15)
 * - docs/DATA_CONTRACT.md (Section 7: Interaction, Section 8: Conversation)
 * - docs/SUPABASE_SCHEMA_DESIGN.md (Section 3.8: conversations, Section 3.9: interactions)
 */

export const INBOX_CHANNELS = {
  ZALO: 'zalo',
  FACEBOOK: 'facebook',
} as const;

export type InboxChannel = (typeof INBOX_CHANNELS)[keyof typeof INBOX_CHANNELS];

export const SENDER_TYPES = {
  CUSTOMER: 'customer',
  SALE: 'sale',
  AI: 'ai',
} as const;

export type SenderType = (typeof SENDER_TYPES)[keyof typeof SENDER_TYPES];

export const CONVERSATION_STATUSES = {
  OPEN: 'OPEN',
  PENDING_SALE: 'PENDING_SALE',
  AI_HANDLING: 'AI_HANDLING',
  CLOSED: 'CLOSED',
} as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[keyof typeof CONVERSATION_STATUSES];

/**
 * Integrated Conversation Entity for the 3-column Inbox
 */
export interface Conversation {
  id: string;
  company_id: string; // MANDATORY - Strict Tenant Isolation
  customer_id: string;
  customer_name: string;
  customer_code: string;
  customer_phone?: string;
  customer_stage?: string;
  customer_source?: string;
  channel: InboxChannel;
  /** Facebook Page that owns this conversation. Present for Facebook conversations. */
  channel_page_id?: string;
  channel_page_name?: string;
  last_message: string;
  last_message_at?: string;
  unread_count: number;
  status: ConversationStatus;
  metadata?: Record<string, unknown>;
  updated_at: string;
  created_at?: string;
}

/**
 * Trạng thái chuyển phát tin nhắn Outbound (Delivery Lifecycle)
 */
export type MessageDeliveryStatus =
  | 'PENDING_DISPATCH'
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'PENDING'
  | 'PROCESSING'
  | 'RETRY'
  | 'RECONCILE_REQUIRED';

/**
 * Checks if a delivery status is non-terminal / in-flight
 */
export function isPendingDelivery(status?: string): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return (
    s === 'PENDING_DISPATCH' ||
    s === 'PENDING' ||
    s === 'PROCESSING' ||
    s === 'RETRY' ||
    s === 'QUEUED'
  );
}

/**
 * Monotonic Delivery Status Reconciliation Helper
 * Prevents stale responses from downgrading terminal statuses (SENT, DELIVERED, etc.)
 */
export function mergeDeliveryStatus(
  localStatus?: MessageDeliveryStatus | string,
  incomingStatus?: MessageDeliveryStatus | string
): MessageDeliveryStatus | undefined {
  if (!localStatus && !incomingStatus) return undefined;
  if (!incomingStatus) return (localStatus as MessageDeliveryStatus) || undefined;
  if (!localStatus) return (incomingStatus as MessageDeliveryStatus) || undefined;

  const normLocal = localStatus.toUpperCase();
  const normIncoming = incomingStatus.toUpperCase();

  if (normLocal === normIncoming) {
    return incomingStatus as MessageDeliveryStatus;
  }

  // Once DELIVERED, never downgrade to SENT or any non-terminal state
  if (normLocal === 'DELIVERED') {
    if (normIncoming === 'SENT' || isPendingDelivery(normIncoming)) {
      return 'DELIVERED';
    }
  }

  // If incoming is DELIVERED, upgrade from SENT or non-terminal
  if (normIncoming === 'DELIVERED') {
    return 'DELIVERED';
  }

  // Once SENT, never downgrade to any non-terminal state
  if (normLocal === 'SENT') {
    if (isPendingDelivery(normIncoming)) {
      return 'SENT';
    }
  }

  // If local is non-terminal, incoming SENT upgrades it
  if (isPendingDelivery(normLocal)) {
    if (normIncoming === 'SENT') {
      return 'SENT';
    }
  }

  // Terminal error states: do not downgrade FAILED or RECONCILE_REQUIRED to non-terminal
  if (
    (normLocal === 'FAILED' || normLocal === 'RECONCILE_REQUIRED') &&
    isPendingDelivery(normIncoming)
  ) {
    return localStatus as MessageDeliveryStatus;
  }

  // Do not downgrade terminal state to non-terminal
  if (
    (normLocal === 'SENT' ||
      normLocal === 'DELIVERED' ||
      normLocal === 'FAILED' ||
      normLocal === 'RECONCILE_REQUIRED') &&
    isPendingDelivery(normIncoming)
  ) {
    return localStatus as MessageDeliveryStatus;
  }

  return incomingStatus as MessageDeliveryStatus;
}

/**
 * Hợp đồng chuyển phát tin nhắn Outbound (Outbound Dispatcher Port - Member 3 Zalo & Member 4 Facebook)
 */
export interface OutboundDispatchResult {
  dispatched: boolean;
  provider_message_id?: string;
  delivery_status: MessageDeliveryStatus;
  error?: string;
}

export type OutboxJobStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'RETRY' | 'RECONCILE_REQUIRED';

export type ReconciliationStatus = 'NONE' | 'RECONCILE_REQUIRED' | 'RECONCILED_SENT' | 'RECONCILED_NOT_SENT';

/**
 * Bản ghi Outbound Delivery phục vụ Transactional Outbox Worker
 */
export interface OutboundDeliveryRecord {
  id: string;
  company_id: string;
  conversation_id: string;
  interaction_id: string;
  channel: string;
  provider?: string | null;
  content?: string | null;
  delivery_status: MessageDeliveryStatus;
  status?: OutboxJobStatus;
  client_command_id?: string | null;
  provider_message_id?: string | null;
  retry_count: number;
  attempt_count?: number;
  next_retry_at?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
  processing_started_at?: string | null;
  lease_expires_at?: string | null;
  reconciliation_status?: ReconciliationStatus;
  error_message?: string | null;
  last_error?: string | null;
  sent_at?: string | null;
  idempotency_key?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Outbox Job cho Facebook Browser Worker (Phase 2B & 2B.1)
 */
export interface FacebookBrowserOutboxJob {
  id: string;
  company_id: string;
  conversation_id: string;
  channel: string;
  provider: string;
  content: string;
  status: OutboxJobStatus;
  attempt_count: number;
  next_retry_at?: string | null;
  processing_started_at?: string | null;
  lease_expires_at?: string | null;
  reconciliation_status?: ReconciliationStatus;
  locked_at?: string | null;
  locked_by?: string | null;
  last_error?: string | null;
  created_at: string;
  sent_at?: string | null;
  idempotency_key?: string | null;
  metadata?: {
    page_id?: string;
    page_name?: string;
    customer_fb_id?: string | null;
    external_conversation_id?: string | null;
    customer_name?: string;
    [key: string]: unknown;
  };
}

/**
 * Message/Interaction item within a conversation
 * Tuân thủ public.interactions (Sanitized Derivative Security Zone) & private raw contents schema
 */
export interface InboxMessage {
  id: string;
  company_id?: string;
  conversation_id: string;
  customer_id: string;
  channel: InboxChannel;
  sender_type: SenderType;
  sender_name?: string;
  sender_id?: string;
  content: string; // Mặc định hiển thị sanitized_content (an toàn cho DTO công khai)
  sanitized_content?: string; // Bản làm sạch che số điện thoại (Zero-Phone Security Zone)
  sanitization_status?: 'CLEAN' | 'SANITIZED' | 'RAW' | 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'NOT_REQUIRED'; // Trạng thái làm sạch dữ liệu
  raw_content?: string; // Vùng riêng tư (private): chỉ cấp cho BOSS_ADMIN khi có thẩm quyền
  created_at: string;
  direction?: 'inbound' | 'outbound' | 'INBOUND' | 'OUTBOUND';
  delivery_status?: MessageDeliveryStatus;
  client_command_id?: string;
  is_duplicate?: boolean;
}

/**
 * Input for sending a reply message from Sale
 */
export interface SendMessageInput {
  conversation_id: string;
  company_id: string; // MANDATORY - Strict Tenant Isolation
  content: string;
  sender_type?: SenderType;
  sender_name?: string;
  clientCommandId?: string;
  actor_user_id?: string; // Authenticated actor attribution (P0 Requirement 6)
}

export type SendMessageParams = SendMessageInput;
export type SendMessageResult = InboxMessage;

/**
 * Filter query parameters for conversation list
 */
export interface ConversationFilter {
  company_id?: string;
  channel?: InboxChannel | 'all';
  search?: string;
  status?: ConversationStatus | 'all';
  unread_only?: boolean;
}

/**
 * Customer 360 Timeline Event item
 */
export interface CustomerTimelineEvent {
  id: string;
  company_id?: string;
  customer_id: string;
  type: 'MESSAGE' | 'CALL' | 'STAGE_CHANGE' | 'SURVEY' | 'NOTE';
  channel?: string;
  title: string;
  description: string;
  timestamp: string;
  actor_type: 'customer' | 'sale' | 'ai' | 'technician' | 'system';
  actor_name?: string;
  metadata?: Record<string, unknown>;
}
