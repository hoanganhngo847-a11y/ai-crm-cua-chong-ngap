import 'server-only';

import OpenAI from 'openai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { claimResponseSlaForAi } from './response-sla-store';
import {
  executeCustomerAnalysis,
  NoAnalyzableSourcesError,
} from '@/features/ai-analysis/services/analysis-worker';
import type { AiAnalysisRecord } from '@/shared/contracts/ai-analysis';
import {
  buildRuntimeSalesStyleContext,
} from '@/features/sales-style/services/runtime-style-context';
import { dispatchMessage } from '@/features/omnichannel/facebook/transport';
import { binding } from '@/features/omnichannel/facebook/binding';
import {
  ZaloInboxService,
  type ZaloSystemPrincipal,
  type ZaloInboxServiceOptions,
} from '@/features/omnichannel/zalo/inbox-service';
import type { SendZaloReplyResult } from '@/features/omnichannel/zalo/types';

// ==============================================================================
// 1. POLICY FIREWALL VALIDATION & ERROR
// ==============================================================================

export class PolicyFirewallViolationError extends Error {
  constructor(public readonly violationReason: string) {
    super(`BUSINESS_POLICY_FIREWALL_VIOLATION: ${violationReason}`);
    this.name = 'PolicyFirewallViolationError';
  }
}

/**
 * Enforces business policy firewall against invented commercial commitments:
 * - Specific prices, rates, or discounts
 * - Bank accounts, wire transfer requests, or deposit collection
 * - Binding delivery dates or contractual commitments
 */
export function validateAiResponsePolicyFirewall(text: string): { valid: boolean; violationReason?: string } {
  const lower = text.toLowerCase();

  // 1. Price pattern detection (e.g. 5 triệu, 500.000đ, 200k, $50, 10tr)
  const priceRegex = /\b\d+(?:[.,]\d+)?\s*(?:triệu|nghìn|tr|k|vnđ|vnd|đ|đồng|usd|\$)(?:\s*\/\s*(?:m2|m|bộ))?\b/i;
  if (priceRegex.test(lower)) {
    return { valid: false, violationReason: 'Invented or committed price detected' };
  }

  // 2. Discount / promotion percentage detection
  const discountRegex = /(?:giảm giá|chiết khấu|khuyến mãi)\s*\d+%/i;
  if (discountRegex.test(lower)) {
    return { valid: false, violationReason: 'Invented discount or percentage promotion detected' };
  }

  // 3. Bank account, STK, wire transfer, or deposit demand
  const bankAccountRegex = /(?:chuyển khoản|stk|số tài khoản|ngân hàng\s+[a-z]+|đặt cọc\s*(?:trước|ngay)?\s*\d+)/i;
  if (bankAccountRegex.test(lower)) {
    return { valid: false, violationReason: 'Bank account, transfer, or deposit commitment detected' };
  }

  // 4. Binding delivery or contract commitments
  const bindingCommitmentRegex = /(?:cam kết giao hàng vào ngày|cam kết bảo hành trọn đời|hợp đồng cam kết|ký hợp đồng ngay bây giờ)/i;
  if (bindingCommitmentRegex.test(lower)) {
    return { valid: false, violationReason: 'Binding delivery or contract commitment detected' };
  }

  return { valid: true };
}

// ==============================================================================
// 2. MODEL INTERFACE & OPENAI IMPLEMENTATION
// ==============================================================================

export interface AiResponseModel {
  readonly modelVersion: string;
  generateResponse(params: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string>;
}

export class OpenAiResponseModel implements AiResponseModel {
  public readonly modelVersion: string;
  private readonly openai: OpenAI;

  constructor(options?: { modelVersion?: string; apiKey?: string; client?: OpenAI }) {
    this.modelVersion =
      options?.modelVersion ||
      process.env.AI_RESPONSE_MODEL_VERSION ||
      'gpt-4o-mini';
    this.openai =
      options?.client ||
      new OpenAI({
        apiKey: options?.apiKey || process.env.OPENAI_API_KEY || 'dummy_test_key',
      });
  }

  async generateResponse(params: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> {
    const res = await this.openai.chat.completions.create({
      model: this.modelVersion,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content?.trim() || '';
  }
}

// ==============================================================================
// 3. OUTBOUND PROVIDER TYPES & CANONICAL CHANNEL DISPATCHERS
// ==============================================================================

export interface OutboundProviderResult {
  status: 'SENT' | 'FAILED' | 'UNKNOWN' | 'UNCERTAIN';
  externalMessageId?: string;
  error?: string;
  /** For Zalo, the canonical deliveryId from zalo_outbound_deliveries. */
  canonicalDeliveryId?: string;
  /** For Zalo, the canonical interactionId from zalo_finalize_outbound_delivery. */
  canonicalInteractionId?: string;
}

export type OutboundProviderSender = (params: {
  companyId: string;
  conversationId: string;
  customerId: string;
  channel: string;
  content: string;
  deliveryId: string;
}) => Promise<OutboundProviderResult>;

/**
 * Facebook AI outbound dispatch using canonical infrastructure:
 * 1. Uses binding() to resolve page→company→token (canonical multi-tenant page config)
 * 2. Uses dispatchMessage() canonical transport
 *
 * Does NOT use han_prepare_send (which requires SALE/BOSS_ADMIN role).
 * The AI outbox (create_ai_outbound_delivery_pending / finalize_ai_outbound_delivery_atomic)
 * handles the AI-specific lifecycle separately.
 */
async function dispatchFacebookCanonical(params: {
  companyId: string;
  conversationId: string;
  client: SupabaseClient;
}): Promise<{ pageId: string; recipientPsid: string; token: string; version: string } | OutboundProviderResult> {
  const { companyId, conversationId, client } = params;

  // 1. Fetch conversation external_conversation_id
  const { data: conv } = await client
    .from('conversations')
    .select('external_conversation_id')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .single();

  const externalId = conv?.external_conversation_id || '';
  const parts = externalId.split(':');
  if (parts.length < 2) {
    return { status: 'FAILED', error: 'INVALID_EXTERNAL_CONVERSATION_ID' };
  }

  const pageId = parts[0];
  const recipientPsid = parts.slice(1).join(':');

  // 2. Resolve page binding via canonical binding() infrastructure
  //    This validates page→company mapping and provides the correct token env var.
  let config;
  try {
    config = binding(pageId);
  } catch {
    return { status: 'FAILED', error: 'FACEBOOK_PAGE_NOT_CONFIGURED' };
  }

  // 3. Verify tenant isolation: page binding must match the claimed company
  if (config.company !== companyId) {
    return { status: 'FAILED', error: 'FACEBOOK_PAGE_COMPANY_MISMATCH' };
  }

  // 4. Resolve token from the canonical env var declared in the binding
  const token = (process.env[config.tokenEnv] || '').trim();
  if (!token) {
    return { status: 'FAILED', error: 'FACEBOOK_NOT_CONFIGURED' };
  }

  const version = (process.env.META_GRAPH_VERSION || '').trim();
  if (!version || !/^v\d+\.\d+$/.test(version)) {
    return { status: 'FAILED', error: 'META_GRAPH_VERSION_NOT_CONFIGURED' };
  }

  return { pageId, recipientPsid, token, version };
}

/**
 * Zalo AI outbound dispatch using the full canonical ZaloInboxService.sendSystemZaloReply().
 *
 * Delegates entirely to the existing durable outbox:
 *   1. zalo_claim_outbound_delivery (idempotent claim, tenant-isolated)
 *   2. ZaloClient.sendTextMessageWithOutcome (real provider call)
 *   3. zalo_record_outbound_provider_result (persists outcome immediately)
 *   4. zalo_finalize_outbound_delivery (creates interaction, updates conversation, resolves SLA)
 *
 * No parallel architecture; no direct Zalo API calls from the AI runtime.
 */
async function dispatchZaloCanonical(params: {
  companyId: string;
  conversationId: string;
  content: string;
  claimId: string | null;
  zaloServiceOptions?: ZaloInboxServiceOptions;
}): Promise<OutboundProviderResult> {
  const { companyId, conversationId, content, claimId, zaloServiceOptions } = params;

  const service = new ZaloInboxService(zaloServiceOptions);
  const principal: ZaloSystemPrincipal = {
    kind: 'SYSTEM_WORKER',
    companyId,
    actorType: 'AI',
    workerName: 'ai-response-runtime',
  };

  const commandId = `ai-sla-${claimId}`;

  let result: SendZaloReplyResult;
  try {
    result = await service.sendSystemZaloReply(
      {
        conversationId,
        content,
        commandId,
      },
      principal,
    );
  } catch (err: unknown) {
    return {
      status: 'FAILED',
      error: err instanceof Error ? err.message : 'Zalo canonical send failed',
    };
  }

  // Map canonical SendZaloReplyResult → OutboundProviderResult
  if (result.success && (result.status === 'SENT' || result.status === 'ALREADY_SENT')) {
    return {
      status: 'SENT',
      externalMessageId: result.externalMessageId,
      canonicalDeliveryId: result.deliveryId,
      canonicalInteractionId: result.interactionId,
    };
  }

  if (result.status === 'PENDING_FINALIZE') {
    // Provider accepted but DB finalization pending. Reconciler handles it.
    return {
      status: 'UNCERTAIN',
      canonicalDeliveryId: result.deliveryId,
      error: result.error || 'Zalo message sent but DB finalization pending',
    };
  }

  return {
    status: result.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED',
    canonicalDeliveryId: result.deliveryId,
    error: result.error || `Zalo dispatch ended with status ${result.status}`,
  };
}

// ==============================================================================
// 4. RUNTIME EXECUTION PARAMS & RESULT
// ==============================================================================

export interface ExecuteAiResponseRuntimeParams {
  companyId: string;
  windowId: string;
  model?: AiResponseModel;
  providerSender?: OutboundProviderSender;
  client?: SupabaseClient;
  /** Override ZaloInboxService construction (tests only). */
  zaloServiceOptions?: ZaloInboxServiceOptions;
}

export interface ExecuteAiResponseRuntimeResult {
  success: boolean;
  claimed: boolean;
  decision?: string;
  windowId: string;
  conversationId?: string;
  deliveryId?: string;
  interactionId?: string;
  externalMessageId?: string;
  providerStatus?: string;
  error?: string;
  provenance?: {
    modelVersion: string;
    analysisRecordId: string | null;
    salesStyleProfileId: string | null;
    isNeutralDefault: boolean;
    aiClaimId: string | null;
  };
}

// ==============================================================================
// 5. CANONICAL AI RESPONSE RUNTIME
// ==============================================================================

/**
 * Canonical AI Response Runtime:
 * Inbound Interaction -> Response SLA -> AI Claim -> AI Generation (Analysis + Sales Style + Firewall)
 * -> Channel-Specific Canonical Dispatch:
 *    FACEBOOK: AI outbox (create_ai_outbound_delivery_pending) -> binding() + dispatchMessage
 *              -> finalize_ai_outbound_delivery_atomic
 *    ZALO:     ZaloInboxService.sendSystemZaloReply() (full canonical durable pipeline)
 *
 * No parallel provider architecture. Channels reuse existing canonical infrastructure.
 */
export async function executeAiResponseRuntime(
  params: ExecuteAiResponseRuntimeParams
): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    companyId,
    windowId,
    model = new OpenAiResponseModel(),
    providerSender,
    client = createAdminClient(),
    zaloServiceOptions,
  } = params;

  // Step 1: Claim Response SLA for AI
  const claimResult = await claimResponseSlaForAi({ companyId, windowId });
  if (!claimResult.claimed) {
    return {
      success: false,
      claimed: false,
      decision: claimResult.decision,
      windowId,
    };
  }

  const conversationId = claimResult.conversationId;
  const customerId = claimResult.customerId;

  // Step 2: Fetch Conversation details (assigned Sale user, channel, status)
  const { data: conv, error: convErr } = await client
    .from('conversations')
    .select('id, channel, assigned_to, status')
    .eq('company_id', companyId)
    .eq('id', conversationId)
    .single();

  if (convErr || !conv) {
    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      error: 'Conversation not found',
    };
  }

  // Step 3: Fetch latest inbound customer message
  const { data: latestInbound } = await client
    .from('interactions')
    .select('id, sanitized_content, channel, created_at')
    .eq('company_id', companyId)
    .eq('conversation_id', conversationId)
    .eq('direction', 'INBOUND')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const customerQuery = latestInbound?.sanitized_content || 'Xin chào công ty';

  // Step 4: AI Customer Analysis (sanitized only, zero raw phone, graceful degradation)
  let analysisRecord: AiAnalysisRecord | null = null;
  try {
    analysisRecord = await executeCustomerAnalysis({
      companyId,
      customerId,
      client,
    });
  } catch (err: unknown) {
    if (err instanceof NoAnalyzableSourcesError) {
      // Degraded safe state
      analysisRecord = null;
    } else {
      analysisRecord = null;
    }
  }

  // Step 5: Sales Style in Runtime (canonical assigned Sale, else safe neutral default)
  const styleContext = await buildRuntimeSalesStyleContext({
    companyId,
    saleUserId: conv.assigned_to,
    client,
  });

  // Step 6: Compose Prompts & Generate Response
  const analysisContextSection = analysisRecord
    ? `[CUSTOMER JOURNEY INSIGHT (SANITIZED)]
- Nhận định: ${analysisRecord.summary}
- Gợi ý giai đoạn: ${analysisRecord.stageSuggestion || 'Không thay đổi'}
- Khó khăn/Trở ngại: ${(analysisRecord.objections || []).join(', ') || 'Không ghi nhận'}
- Hành động đề xuất: ${analysisRecord.nextAction || 'Tư vấn giải pháp tiêu chuẩn'}`
    : `[CUSTOMER JOURNEY INSIGHT]
- Khách hàng mới hoặc chưa có lịch sử tương tác đủ điều kiện phân tích.`;

  const systemPrompt = [
    `Bạn là trợ lý AI chuyên nghiệp tư vấn giải pháp cửa chống ngập cho khách hàng.`,
    styleContext.styleContextPrompt,
    analysisContextSection,
    `[HƯỚNG DẪN BẮT BUỘC]`,
    `- Trả lời ngắn gọn, nhã nhặn, đúng trọng tâm câu hỏi của khách hàng.`,
    `- KHÔNG TỰ BÁO GIÁ CỤ THỂ, KHÔNG HỨA HẸN CHIẾT KHẤU, KHÔNG YÊU CẦU CHUYỂN KHOẢN.`,
    `- Đề xuất chuyên viên kỹ thuật đến khảo sát hiện trường miễn phí để có kích thước và báo giá chuẩn xác.`,
  ].join('\n\n');

  const userPrompt = `Tin nhắn từ khách hàng: "${customerQuery}"`;

  const rawGeneratedText = await model.generateResponse({
    systemPrompt,
    userPrompt,
  });

  // Step 7: Business Policy Firewall Check (Fail-Closed)
  const firewallCheck = validateAiResponsePolicyFirewall(rawGeneratedText);
  if (!firewallCheck.valid) {
    throw new PolicyFirewallViolationError(
      firewallCheck.violationReason || 'Model generated response violates commercial policy firewall'
    );
  }

  const provenance = {
    modelVersion: model.modelVersion,
    analysisRecordId: analysisRecord?.id || null,
    salesStyleProfileId: styleContext.activeProfileId,
    isNeutralDefault: styleContext.isNeutralDefault,
    aiClaimId: claimResult.claimId,
  };

  // Step 8: Channel-Specific Canonical Dispatch
  // Test override: if providerSender is injected, use it (tests only).
  if (providerSender) {
    return executeWithAiOutbox({
      companyId,
      conversationId,
      customerId,
      windowId,
      channel: conv.channel,
      content: rawGeneratedText,
      claimId: claimResult.claimId,
      decision: claimResult.decision,
      provenance,
      providerSender,
      model,
    });
  }

  if (conv.channel === 'ZALO') {
    return executeZaloCanonicalPath({
      companyId,
      conversationId,
      customerId,
      windowId,
      content: rawGeneratedText,
      claimId: claimResult.claimId,
      decision: claimResult.decision,
      provenance,
      zaloServiceOptions,
    });
  }

  if (conv.channel === 'FACEBOOK') {
    return executeFacebookCanonicalPath({
      companyId,
      conversationId,
      customerId,
      windowId,
      content: rawGeneratedText,
      claimId: claimResult.claimId,
      decision: claimResult.decision,
      provenance,
      model,
      client,
    });
  }

  // Unsupported channel: FAIL CLOSED
  return {
    success: false,
    claimed: true,
    decision: claimResult.decision,
    windowId,
    conversationId,
    error: `PROVIDER_NOT_CONFIGURED: Channel "${conv.channel}" has no configured provider transport`,
    provenance,
  };
}

// ==============================================================================
// 6. ZALO CANONICAL PATH (delegates to ZaloInboxService)
// ==============================================================================

/**
 * Zalo AI outbound path: fully delegates to ZaloInboxService.sendSystemZaloReply().
 *
 * The canonical Zalo pipeline (zalo_claim_outbound_delivery → ZaloClient → zalo_record_outbound_provider_result
 * → zalo_finalize_outbound_delivery) handles:
 * - Durable outbox with idempotent command_id
 * - Real provider dispatch via ZaloClientFactory (multi-tenant OA token store)
 * - Atomic interaction creation, provenance, and conversation update
 *
 * SLA resolution is handled by finalize_ai_outbound_delivery_atomic post-send,
 * since zalo_finalize does not resolve response_sla_windows for AI actor_type.
 */
async function executeZaloCanonicalPath(params: {
  companyId: string;
  conversationId: string;
  customerId: string;
  windowId: string;
  content: string;
  claimId: string | null;
  decision: string | undefined;
  provenance: ExecuteAiResponseRuntimeResult['provenance'];
  zaloServiceOptions?: ZaloInboxServiceOptions;
}): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    companyId, conversationId, customerId: _customerId, windowId,
    content, claimId, decision, provenance, zaloServiceOptions,
  } = params;

  const zaloResult = await dispatchZaloCanonical({
    companyId,
    conversationId,
    content,
    claimId,
    zaloServiceOptions,
  });

  if (zaloResult.status !== 'SENT' || !zaloResult.externalMessageId) {
    // Canonical Zalo pipeline failed or is uncertain. No synthetic SENT; fail closed.
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      deliveryId: zaloResult.canonicalDeliveryId,
      providerStatus: zaloResult.status,
      error: zaloResult.error || `Zalo provider delivery failed: ${zaloResult.status}`,
      provenance,
    };
  }

  // Zalo canonical pipeline created the interaction. Now resolve the SLA window atomically.
  const admin = createAdminClient();
  if (windowId) {
    await admin
      .from('response_sla_windows')
      .update({
        state: 'AI_RESPONDED',
        ai_response_interaction_id: zaloResult.canonicalInteractionId || null,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', windowId)
      .eq('company_id', companyId)
      .eq('state', 'OPEN');
  }

  return {
    success: true,
    claimed: true,
    decision,
    windowId,
    conversationId,
    deliveryId: zaloResult.canonicalDeliveryId,
    interactionId: zaloResult.canonicalInteractionId,
    externalMessageId: zaloResult.externalMessageId,
    providerStatus: 'SENT',
    provenance,
  };
}

// ==============================================================================
// 7. FACEBOOK CANONICAL PATH (binding() + dispatchMessage + AI outbox)
// ==============================================================================

/**
 * Facebook AI outbound path:
 * 1. Uses binding() for canonical page→company→token resolution (no direct env reads)
 * 2. Creates pending delivery in AI outbox (create_ai_outbound_delivery_pending)
 * 3. Calls dispatchMessage() canonical transport
 * 4. On SENT: finalize_ai_outbound_delivery_atomic (creates interaction, provenance, SLA)
 * 5. On failure: record_ai_outbound_delivery_failed
 *
 * Does NOT use han_prepare_send (which requires SALE/BOSS_ADMIN role and creates the
 * interaction before provider dispatch, violating the AI invariant of no public interaction
 * before confirmed delivery).
 */
async function executeFacebookCanonicalPath(params: {
  companyId: string;
  conversationId: string;
  customerId: string;
  windowId: string;
  content: string;
  claimId: string | null;
  decision: string | undefined;
  provenance: ExecuteAiResponseRuntimeResult['provenance'];
  model: AiResponseModel;
  client: SupabaseClient;
}): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    companyId, conversationId, customerId, windowId,
    content, claimId, decision, provenance, model, client,
  } = params;

  const admin = createAdminClient();

  // 1. Resolve canonical Facebook config via binding()
  const fbConfig = await dispatchFacebookCanonical({ companyId, conversationId, client });
  if ('status' in fbConfig) {
    // Failed to resolve Facebook config — return error without provider call
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      providerStatus: fbConfig.status,
      error: fbConfig.error,
      provenance,
    };
  }

  // 2. Create pending AI outbox delivery
  const { data: deliveryId, error: deliveryErr } = await admin.rpc('create_ai_outbound_delivery_pending' as never, {
    p_company_id: companyId,
    p_conversation_id: conversationId,
    p_channel: 'FACEBOOK',
    p_client_command_id: claimId,
    p_request_fingerprint: `${companyId}:${conversationId}:${claimId}`,
  } as never);

  if (deliveryErr || !deliveryId) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Failed to create pending outbound delivery: ${deliveryErr?.message}`,
      provenance,
    };
  }

  // 3. Dispatch via canonical Facebook transport
  const fbResult = await dispatchMessage({
    page: fbConfig.pageId,
    recipient: fbConfig.recipientPsid,
    version: fbConfig.version,
    token: fbConfig.token,
    content,
  });

  return finalizeAiOutboundDelivery({
    admin,
    companyId,
    conversationId,
    customerId,
    windowId,
    content,
    claimId,
    decision,
    provenance,
    model,
    deliveryId: String(deliveryId),
    providerStatus: fbResult.status,
    providerMid: fbResult.mid,
  });
}

// ==============================================================================
// 8. TEST PATH: providerSender override
// ==============================================================================

/**
 * Handles the AI outbox path with an injected providerSender (tests).
 */
async function executeWithAiOutbox(params: {
  companyId: string;
  conversationId: string;
  customerId: string;
  windowId: string;
  channel: string;
  content: string;
  claimId: string | null;
  decision: string | undefined;
  provenance: ExecuteAiResponseRuntimeResult['provenance'];
  providerSender: OutboundProviderSender;
  model: AiResponseModel;
}): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    companyId, conversationId, customerId, windowId, channel,
    content, claimId, decision, provenance, providerSender, model,
  } = params;

  const admin = createAdminClient();

  // Create pending delivery in AI outbox
  const { data: deliveryId, error: deliveryErr } = await admin.rpc('create_ai_outbound_delivery_pending' as never, {
    p_company_id: companyId,
    p_conversation_id: conversationId,
    p_channel: channel,
    p_client_command_id: claimId,
    p_request_fingerprint: `${companyId}:${conversationId}:${claimId}`,
  } as never);

  if (deliveryErr || !deliveryId) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Failed to create pending outbound delivery: ${deliveryErr?.message}`,
      provenance,
    };
  }

  // Delegate to injected sender
  const providerResult = await providerSender({
    companyId,
    conversationId,
    customerId,
    channel,
    content,
    deliveryId: String(deliveryId),
  });

  return finalizeAiOutboundDelivery({
    admin,
    companyId,
    conversationId,
    customerId,
    windowId,
    content,
    claimId,
    decision,
    provenance,
    model,
    deliveryId: String(deliveryId),
    providerStatus: providerResult.status,
    providerMid: providerResult.externalMessageId || null,
    providerError: providerResult.error,
  });
}

// ==============================================================================
// 9. SHARED FINALIZATION (Facebook + test paths)
// ==============================================================================

/**
 * Handles post-dispatch finalization for paths that use the AI outbox
 * (create_ai_outbound_delivery_pending / finalize_ai_outbound_delivery_atomic).
 * Used by Facebook canonical path and test providerSender path.
 */
async function finalizeAiOutboundDelivery(params: {
  admin: SupabaseClient;
  companyId: string;
  conversationId: string;
  customerId: string;
  windowId: string;
  content: string;
  claimId: string | null;
  decision: string | undefined;
  provenance: ExecuteAiResponseRuntimeResult['provenance'];
  model: AiResponseModel;
  deliveryId: string;
  providerStatus: string;
  providerMid: string | null | undefined;
  providerError?: string;
}): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    admin, companyId, conversationId, customerId, windowId,
    content, claimId, decision, provenance, model, deliveryId,
    providerStatus, providerMid, providerError,
  } = params;

  // Provider did not confirm SENT with a message ID → fail closed
  if (providerStatus !== 'SENT' || !providerMid) {
    await admin.rpc('record_ai_outbound_delivery_failed' as never, {
      p_company_id: companyId,
      p_delivery_id: deliveryId,
      p_error_message: providerError || `Provider delivery status: ${providerStatus}`,
    } as never);

    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      deliveryId,
      providerStatus,
      error: providerError || `Provider delivery failed with status ${providerStatus}`,
      provenance,
    };
  }

  // Finalize confirmed delivery atomically
  const { data: finalizedInteractionId, error: finalizeErr } = await admin.rpc(
    'finalize_ai_outbound_delivery_atomic' as never,
    {
      p_company_id: companyId,
      p_delivery_id: deliveryId,
      p_conversation_id: conversationId,
      p_customer_id: customerId,
      p_window_id: windowId,
      p_ai_claim_id: claimId,
      p_provider_msg_id: providerMid,
      p_sanitized_content: content,
      p_raw_content: content,
      p_source_metadata: {
        source: 'ai_response_runtime',
        model_version: model.modelVersion,
        analysis_record_id: provenance?.analysisRecordId || null,
        sales_style_profile_id: provenance?.salesStyleProfileId,
        is_neutral_default: provenance?.isNeutralDefault,
        ai_claim_id: claimId,
        window_id: windowId,
        delivery_id: deliveryId,
      },
    } as never
  );

  if (finalizeErr || !finalizedInteractionId) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      deliveryId,
      providerStatus,
      error: `Failed to finalize delivery atomically: ${finalizeErr?.message}`,
    };
  }

  return {
    success: true,
    claimed: true,
    decision,
    windowId,
    conversationId,
    deliveryId,
    interactionId: String(finalizedInteractionId),
    externalMessageId: providerMid,
    providerStatus,
    provenance,
  };
}
