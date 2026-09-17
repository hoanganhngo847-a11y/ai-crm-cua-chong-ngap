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
  company_id?: string;
  customer_id: string;
  customer_name: string;
  customer_code: string;
  customer_phone?: string;
  customer_stage?: string;
  customer_source?: string;
  channel: InboxChannel;
  last_message: string;
  last_message_at?: string;
  unread_count: number;
  status: ConversationStatus;
  updated_at: string;
  created_at?: string;
}

/**
 * Message/Interaction item within a conversation
 */
export interface InboxMessage {
  id: string;
  conversation_id: string;
  customer_id: string;
  channel: InboxChannel;
  sender_type: SenderType;
  sender_name?: string;
  content: string;
  created_at: string;
  direction?: 'inbound' | 'outbound';
}

/**
 * Input for sending a reply message from Sale
 */
export interface SendMessageInput {
  conversation_id: string;
  content: string;
  sender_type?: SenderType;
}

/**
 * Filter query parameters for conversation list
 */
export interface ConversationFilter {
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
