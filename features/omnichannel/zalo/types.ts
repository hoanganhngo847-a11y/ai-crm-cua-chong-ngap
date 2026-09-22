/**
 * Types and Interfaces for Zalo OA Integration & Webhook Handling
 * Project: AI CRM Cửa Chống Ngập
 * Member 3 (Hùng) - Ownership: features/omnichannel/zalo/
 */

export interface ZaloConfig {
  oaId: string;
  appId: string;
  appSecret: string;
  accessToken?: string;
  refreshToken?: string;
  webhookSecret?: string;
}

export interface ZaloTokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

export interface ZaloTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: string | number;
  error?: number;
  message?: string;
}

export type ZaloWebhookEventType =
  | 'user_send_text'
  | 'user_send_image'
  | 'user_send_link'
  | 'user_send_sticker'
  | 'user_send_audio'
  | 'user_send_video'
  | 'user_send_file'
  | 'oa_send_text'
  | 'follow'
  | 'unfollow'
  | string;

export interface ZaloWebhookSender {
  id: string;
}

export interface ZaloWebhookRecipient {
  id: string;
}

export interface ZaloWebhookAttachment {
  type: string;
  payload?: {
    url?: string;
    thumbnail?: string;
    name?: string;
    size?: number;
    coordinates?: { latitude: string; longitude: string };
    [key: string]: unknown;
  };
}

export interface ZaloWebhookMessage {
  msg_id: string;
  text?: string;
  attachments?: ZaloWebhookAttachment[];
  [key: string]: unknown;
}

export interface ZaloWebhookPayload {
  event_name: ZaloWebhookEventType;
  app_id?: string;
  oa_id?: string;
  sender: ZaloWebhookSender;
  recipient: ZaloWebhookRecipient;
  message?: ZaloWebhookMessage;
  timestamp: number | string;
  user_id_by_app?: string;
  mac?: string;
  info?: Record<string, unknown>;
}

export interface ZaloSendResponse {
  error: number;
  message: string;
  data?: {
    message_id: string;
  };
}

export interface ZaloUserProfile {
  user_id: string;
  user_gender?: number;
  user_name?: string;
  avatar?: string;
  error?: number;
  message?: string;
}

// Interfaces exported for Member 2 (Unified Inbox Integration)
export interface ZaloConversationItem {
  id: string;
  companyId: string;
  customerId: string;
  customerName?: string;
  channel: 'ZALO';
  externalConversationId: string;
  lastMessageAt: string;
  unreadCount: number;
  status: 'OPEN' | 'PENDING_SALE' | 'AI_HANDLING' | 'CLOSED';
  assignedTo?: string | null;
}

export interface ZaloMessageItem {
  id: string;
  conversationId: string;
  customerId: string;
  channel: 'ZALO';
  type: 'MESSAGE';
  direction: 'INBOUND' | 'OUTBOUND';
  content: string;
  externalRef: string | null;
  actorType: 'CUSTOMER' | 'SALE' | 'SYSTEM' | 'AI' | 'TECHNICIAN';
  actorUserId?: string | null;
  createdAt: string;
}

export interface SendZaloReplyParams {
  companyId: string;
  customerId: string;
  conversationId: string;
  content: string;
  recipientZaloId: string;
  saleUserId?: string | null;
}

export interface SendZaloReplyResult {
  success: boolean;
  interactionId?: string;
  externalMessageId?: string;
  error?: string;
}
