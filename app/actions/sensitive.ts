'use server';

import { createClient } from '../../lib/supabase/server';
import {
  type ClickToCallParams,
  type ClickToCallResult,
  type SanitizedInteractionDTO,
  type SignedUrlRequest,
  type SignedUrlResult,
  type CallTranscriptDTO,
} from '../../shared/contracts/sensitive';
import {
  internalClickToCallAction,
  internalGetSanitizedInteractionAction,
  internalGetAuthorizedSignedUrlAction,
  internalViewBossRawPhoneAction,
  internalGetCallTranscriptAction,
} from '../../lib/sensitive/action-handlers';

// ==============================================================================
// EXPORTED 'use server' ACTIONS (Browser Boundary — Serializable Business Input Only)
// ZERO dependency injection parameters cross this boundary.
// ==============================================================================

/**
 * Server Action: Click-To-Call
 * Browser sends identifiers only (customerId). Never phone!
 */
export async function clickToCallAction(
  params: ClickToCallParams
): Promise<{ success: boolean; data?: ClickToCallResult; error?: string; message?: string }> {
  const client = await createClient();
  return internalClickToCallAction(params, client);
}

/**
 * Server Action: Lấy nội dung tương tác đã làm sạch cho SALE
 */
export async function getSanitizedInteractionAction(
  params: { interactionId: string }
): Promise<{ success: boolean; data?: SanitizedInteractionDTO; error?: string; message?: string }> {
  const client = await createClient();
  return internalGetSanitizedInteractionAction(params, client);
}

/**
 * Server Action: Tạo liên kết tải tệp có chữ ký số (Signed URL)
 * Takes ONLY resource identity and slot/variant. Never client-controlled paths!
 */
export async function getAuthorizedSignedUrlAction(
  params: SignedUrlRequest
): Promise<{ success: boolean; data?: SignedUrlResult; error?: string; message?: string }> {
  const client = await createClient();
  return internalGetAuthorizedSignedUrlAction(params, client);
}

/**
 * Server Action: Xem số điện thoại khách hàng dành cho BOSS_ADMIN (Audit-first)
 * Requires BOSS_ADMIN, active membership, and MFA/AAL2 in production.
 */
export async function viewBossRawPhoneAction(
  params: { customerId: string; reason: string }
): Promise<{ success: boolean; rawPhone?: string; error?: string; message?: string }> {
  const client = await createClient();
  return internalViewBossRawPhoneAction(params, client);
}

/**
 * Server Action: Lấy nội dung bóc băng cuộc gọi nguyên văn dành cho BOSS_ADMIN (Audit-first)
 * Requires BOSS_ADMIN, active membership, same company, and MFA/AAL2 in production.
 * SALE and TECHNICIAN are strictly denied.
 */
export async function getCallTranscriptAction(
  params: { callId: string }
): Promise<{ success: boolean; data?: CallTranscriptDTO; error?: string; message?: string }> {
  const client = await createClient();
  return internalGetCallTranscriptAction(params, client);
}
