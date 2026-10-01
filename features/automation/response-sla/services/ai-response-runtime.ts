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
  constructor(message: string) {
    super(message);
    this.name = 'PolicyFirewallViolationError';
  }
}

/**
 * Validates generated AI responses against business policy firewall.
 * Strictly prohibits:
 * - Invented or committed prices
 * - Invented discounts or promotions
 * - Unofficial payment requests or personal bank accounts
 * - Commercial commitments (guaranteeing exact dates, SLA waivers)
 */
export function validateAiResponsePolicyFirewall(text: string): { valid: boolean; violationReason?: string } {
  const lower = text.toLowerCase();

  // 1. Price pattern detection (e.g. 5 triệu, 500.000đ, 200k, $50, 10tr)
  const priceRegex = /\b\d+(?:[.,]\d+)?\s*(?:triệu|nghìn|tr|k|vnđ|vnd|đ|đồng|usd|\$)(?:\s*\/\s*(?:m2|m|bộ))?\b/i;
  if (priceRegex.test(lower)) {
    return { valid: false, violationReason: 'Invented or committed price detected' };
  }

  // 2. Discount / promotion percentage detection
  const discountRegex = /(?:giảm|chiết khấu|khuyến mãi|ưu đãi)\s*\d+%/i;
  if (discountRegex.test(lower)) {
    return { valid: false, violationReason: 'Invented discount or promotion detected' };
  }

  // 3. Bank account / direct transfer requests
  const bankRegex = /(?:stk|số tài khoản|chuyển khoản vào|ngân hàng|techcombank|vietcombank|mbbank|acb|vpbank|bidv)\s*(?::|số|\b)\s*\d{6,}/i;
  if (bankRegex.test(lower)) {
    return { valid: false, violationReason: 'Direct payment or unverified bank account transfer requested' };
  }

  // 4. Invented absolute warranty/delivery commitments
  const commitmentRegex = /(?:cam kết giao hàng trong|chắc chắn hoàn thành trong|bảo hành trọn đời|đền bù \d+ lần)/i;
  if (commitmentRegex.test(lower)) {
    return { valid: false, violationReason: 'Unauthorized absolute commercial commitment detected' };
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
  private readonly client: OpenAI;

  constructor(modelVersion = 'gpt-4o-mini') {
    this.modelVersion = modelVersion;
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || 'sk-test-key-ai-response-runtime',
    });
  }

  async generateResponse(params: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> {
    const { systemPrompt, userPrompt } = params;
    const res = await this.client.chat.completions.create({
      model: this.modelVersion,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content?.trim() || '';
  }
}

// ==============================================================================
// 3. OUTBOUND PROVIDER TYPES & CANONICAL CHANNEL DISPATCHERS
// ==============================================================================

export type ProviderDeliveryStatus = 'SENT' | 'FAILED' | 'UNKNOWN' | 'UNCERTAIN';

export interface OutboundProviderResult {
  status: ProviderDeliveryStatus;
  externalMessageId?: string;
  error?: string;
  canonicalDeliveryId?: string;
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
 * Facebook AI outbound config resolution via canonical binding().
 */
async function dispatchFacebookCanonical(params: {
  companyId: string;
  conversationId: string;
  client: SupabaseClient;
}): Promise<{ pageId: string; recipientPsid: string; token: string; version: string } | OutboundProviderResult> {
  const { companyId, conversationId, client } = params;

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

  let config;
  try {
    config = binding(pageId);
  } catch {
    return { status: 'FAILED', error: 'FACEBOOK_PAGE_NOT_CONFIGURED' };
  }

  if (config.company !== companyId) {
    return { status: 'FAILED', error: 'FACEBOOK_PAGE_COMPANY_MISMATCH' };
  }

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
 * Zalo AI outbound dispatch using canonical ZaloInboxService.sendSystemZaloReply().
 * Stable command ID across all claims/reclaims: `ai-sla-win-${windowId}`.
 */
async function dispatchZaloCanonical(params: {
  companyId: string;
  conversationId: string;
  content: string;
  windowId: string;
  zaloServiceOptions?: ZaloInboxServiceOptions;
}): Promise<OutboundProviderResult> {
  const { companyId, conversationId, content, windowId, zaloServiceOptions } = params;

  const service = new ZaloInboxService(zaloServiceOptions);
  const principal: ZaloSystemPrincipal = {
    kind: 'SYSTEM_WORKER',
    companyId,
    actorType: 'AI',
    workerName: 'ai-response-runtime',
  };

  const commandId = `ai-sla-win-${windowId}`;

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

  if (result.success && (result.status === 'SENT' || result.status === 'ALREADY_SENT')) {
    const verifiedStatus: ProviderDeliveryStatus = (result.status === 'ALREADY_SENT' ? 'SENT' : result.status) as ProviderDeliveryStatus;
    return {
      status: verifiedStatus,
      externalMessageId: result.externalMessageId,
      canonicalDeliveryId: result.deliveryId,
      canonicalInteractionId: result.interactionId,
    };
  }

  if (result.status === 'PENDING_FINALIZE') {
    return {
      status: 'UNCERTAIN',
      canonicalDeliveryId: result.deliveryId,
      externalMessageId: result.externalMessageId,
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
  claimId?: string;
  conversationId?: string;
  customerId?: string;
  model?: AiResponseModel;
  providerSender?: OutboundProviderSender;
  client?: SupabaseClient;
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
// 5. CORE AI RESPONSE RUNTIME ORCHESTRATION
// ==============================================================================

/**
 * Canonical AI Response Runtime:
 * Inbound Interaction -> Response SLA -> AI Claim -> AI Generation (Analysis + Sales Style + Firewall)
 * -> Authoritative Pre-Dispatch DB Guard (row lock, claim check, Sale race check, lease check)
 * -> Immediate Provider Outcome Persistence (record_ai_outbound_provider_result: PROVIDER_SENT_PENDING_FINALIZE)
 * -> Atomic Finalization (public.interactions + private provenance + SLA resolution)
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

  let claimId = params.claimId || null;
  let decision: string | undefined = 'ALLOW_AI_REPLY';
  let conversationId = params.conversationId;
  let customerId = params.customerId;

  // Step 1: Claim Response SLA for AI (if not already claimed by caller)
  if (!claimId || !conversationId || !customerId) {
    const claimResult = await claimResponseSlaForAi({ companyId, windowId });
    if (!claimResult.claimed) {
      return {
        success: false,
        claimed: false,
        decision: claimResult.decision,
        windowId,
        conversationId: claimResult.conversationId,
        error: `Failed to claim Response SLA window for AI: ${claimResult.decision}`,
      };
    }
    claimId = claimResult.claimId!;
    decision = claimResult.decision;
    conversationId = claimResult.conversationId!;
    customerId = claimResult.customerId!;
  }

  // Step 2: Fetch Conversation Metadata (Fail-Closed)
  const { data: conv, error: convErr } = await client
    .from('conversations')
    .select('id, company_id, channel, status, assigned_to')
    .eq('id', conversationId)
    .eq('company_id', companyId)
    .single();

  if (convErr || !conv) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Failed to fetch conversation: ${convErr?.message || 'Not found'}`,
    };
  }

  // Step 3: Run AI Customer Analysis
  let analysisRecord: AiAnalysisRecord | null = null;
  try {
    analysisRecord = await executeCustomerAnalysis({
      companyId,
      customerId,
      client,
    });
  } catch (err: unknown) {
    if (err instanceof NoAnalyzableSourcesError) {
      analysisRecord = null;
    } else {
      analysisRecord = null;
    }
  }

  // Step 4: Resolve Active Sales Style Context
  const styleContext = await buildRuntimeSalesStyleContext({
    companyId,
    saleUserId: conv.assigned_to,
    client,
  });

  // Step 5: Fetch Recent Interaction History for Prompt Context
  const { data: recentInteractions } = await client
    .from('interactions')
    .select('id, direction, actor_type, sanitized_content, created_at')
    .eq('conversation_id', conversationId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })
    .limit(10);

  const conversationHistoryText = (recentInteractions || [])
    .map((i) => `[${i.direction} - ${i.actor_type}]: ${i.sanitized_content}`)
    .join('\n');

  // Step 6: Compose Prompts & Generate Candidate Response
  const systemPrompt = `Bạn là trợ lý AI chuyên nghiệp tư vấn sản phẩm cửa chống ngập cho khách hàng.
Bạn PHẢI tuân thủ các quy tắc sau:
1. KHÔNG BAO GIỜ tự tiện cam kết hoặc báo giá chính xác, giảm giá, chiết khấu nếu chưa có xác nhận từ Sale hoặc khảo sát kỹ thuật.
2. KHÔNG BAO GIỜ yêu cầu khách hàng chuyển khoản vào tài khoản cá nhân.
3. Luôn giữ thái độ lịch sự, chuyên nghiệp, hỗ trợ giải đáp thắc mắc kỹ thuật về cửa chống ngập.

${styleContext.styleContextPrompt}

${
  analysisRecord
    ? `Thông tin phân tích khách hàng:
- Tóm tắt nhu cầu: ${analysisRecord.summary}
- Gợi ý giai đoạn: ${analysisRecord.stageSuggestion || 'N/A'}
- Phản hồi/kháng cự: ${analysisRecord.objections?.join(', ') || 'Không có'}
- Hành động đề xuất: ${analysisRecord.nextAction || 'Tư vấn kỹ thuật'}`
    : 'Chưa có dữ liệu phân tích khách hàng trước đó. Hãy phản hồi chu đáo.'
}`;

  const userPrompt = `Lịch sử hội thoại gần đây:\n${conversationHistoryText}\n\nHãy tạo phản hồi hỗ trợ khách hàng tiếp theo một cách phù hợp.`;

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
    aiClaimId: claimId,
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
      claimId,
      decision,
      provenance,
      providerSender,
      model,
      client,
    });
  }

  if (conv.channel === 'ZALO') {
    return executeZaloCanonicalPath({
      companyId,
      conversationId,
      customerId,
      windowId,
      content: rawGeneratedText,
      claimId,
      decision,
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
      claimId,
      decision,
      provenance,
      model,
      client,
    });
  }

  // Unsupported channel: FAIL CLOSED
  return {
    success: false,
    claimed: true,
    decision,
    windowId,
    conversationId,
    error: `PROVIDER_NOT_CONFIGURED: Channel "${conv.channel}" has no configured provider transport`,
    provenance,
  };
}

// ==============================================================================
// 6. ZALO CANONICAL PATH (delegates to ZaloInboxService + Pre-Dispatch Guard)
// ==============================================================================

interface GuardPreDispatchRow {
  granted: boolean;
  reason: string;
  delivery_id: string | null;
  provider_msg_id: string | null;
  interaction_id: string | null;
  window_state: string | null;
  dispatch_token: string | null;
}

// ==============================================================================
// 6. ZALO CANONICAL PATH (delegates to ZaloInboxService + Pre-Dispatch Guard)
// ==============================================================================

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
    companyId, conversationId, customerId, windowId,
    content, claimId, decision, provenance, zaloServiceOptions,
  } = params;

  const admin = createAdminClient();

  // Authoritative Pre-Dispatch DB Guard (Blocker B)
  const { data: guardRows, error: guardErr } = await admin.rpc(
    'guard_ai_pre_dispatch' as never,
    {
      p_company_id: companyId,
      p_conversation_id: conversationId,
      p_customer_id: customerId,
      p_window_id: windowId,
      p_ai_claim_id: claimId,
      p_channel: 'ZALO',
      p_lease_seconds: 120,
    } as never
  );

  const guard = ((guardRows as unknown) as GuardPreDispatchRow[] | null)?.[0];
  if (guardErr || !guard) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Pre-dispatch guard query failed: ${guardErr?.message || 'No row'}`,
      provenance,
    };
  }

  if (!guard.granted) {
    if (guard.reason === 'SALE_ALREADY_RESPONDED') {
      return {
        success: false,
        claimed: true,
        decision: 'SALE_ALREADY_RESPONDED',
        windowId,
        conversationId,
        error: 'Dispatch denied: Sale has already responded to this customer',
        provenance,
      };
    }
    if (guard.reason === 'ALREADY_SENT') {
      return {
        success: true,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        interactionId: guard.interaction_id ?? undefined,
        externalMessageId: guard.provider_msg_id ?? undefined,
        providerStatus: 'SENT',
        provenance,
      };
    }
    if (guard.reason === 'PENDING_FINALIZE') {
      // Crash recovery: provider accepted previously, finalize DB state atomically!
      const intId = guard.interaction_id;

      const { data: finalIntId, error: finSlaErr } = await admin.rpc(
        'finalize_ai_zalo_sla_atomic' as never,
        {
          p_company_id: companyId,
          p_window_id: windowId,
          p_ai_claim_id: claimId,
          p_zalo_delivery_id: guard.delivery_id,
          p_interaction_id: intId || null,
          p_provider_msg_id: guard.provider_msg_id || null,
          p_source_metadata: {
            source: 'ai_response_runtime',
            model_version: provenance?.modelVersion,
            analysis_record_id: provenance?.analysisRecordId,
            sales_style_profile_id: provenance?.salesStyleProfileId,
            is_neutral_default: provenance?.isNeutralDefault,
            ai_claim_id: claimId,
            window_id: windowId,
            delivery_id: guard.delivery_id,
            command_id: `ai-sla-win-${windowId}`,
          },
        } as never
      );

      if (finSlaErr) {
        return {
          success: false,
          claimed: true,
          decision,
          windowId,
          conversationId,
          deliveryId: guard.delivery_id ?? undefined,
          providerStatus: 'SENT',
          error: `Failed to finalize Zalo SLA during crash recovery: ${finSlaErr.message}`,
          provenance,
        };
      }

      return {
        success: true,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        interactionId: String(finalIntId || intId),
        externalMessageId: guard.provider_msg_id ?? undefined,
        providerStatus: 'SENT',
        provenance,
      };
    }

    if (guard.reason === 'UNCERTAIN') {
      return {
        success: false,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        providerStatus: 'UNCERTAIN',
        error: 'Dispatch denied: Outbound delivery is in UNCERTAIN state',
        provenance,
      };
    }

    if (guard.reason === 'BUSY') {
      return {
        success: false,
        claimed: true,
        decision,
        windowId,
        conversationId,
        providerStatus: 'UNKNOWN',
        error: 'Dispatch denied: Another worker is currently dispatching',
        provenance,
      };
    }

    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Pre-dispatch guard denied: ${guard.reason}`,
      provenance,
    };
  }

  // Pre-dispatch guard passed: dispatch via canonical Zalo service
  const zaloResult = await dispatchZaloCanonical({
    companyId,
    conversationId,
    content,
    windowId,
    zaloServiceOptions,
  });

  if (zaloResult.status !== 'SENT' || !zaloResult.externalMessageId) {
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

  // Atomically finalize SLA window & enrich private raw provenance via trusted RPC (Blocker G & H)
  const { data: finalInteractionId, error: finSlaErr } = await admin.rpc(
    'finalize_ai_zalo_sla_atomic' as never,
    {
      p_company_id: companyId,
      p_window_id: windowId,
      p_ai_claim_id: claimId,
      p_zalo_delivery_id: zaloResult.canonicalDeliveryId,
      p_interaction_id: zaloResult.canonicalInteractionId,
      p_provider_msg_id: zaloResult.externalMessageId,
      p_source_metadata: {
        source: 'ai_response_runtime',
        model_version: provenance?.modelVersion,
        analysis_record_id: provenance?.analysisRecordId,
        sales_style_profile_id: provenance?.salesStyleProfileId,
        is_neutral_default: provenance?.isNeutralDefault,
        ai_claim_id: claimId,
        window_id: windowId,
        delivery_id: zaloResult.canonicalDeliveryId,
        command_id: `ai-sla-win-${windowId}`,
      },
    } as never
  );

  if (finSlaErr) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      deliveryId: zaloResult.canonicalDeliveryId,
      interactionId: zaloResult.canonicalInteractionId,
      externalMessageId: zaloResult.externalMessageId,
      providerStatus: 'SENT',
      error: `Failed to finalize Zalo SLA atomically: ${finSlaErr.message}`,
      provenance,
    };
  }

  return {
    success: true,
    claimed: true,
    decision,
    windowId,
    conversationId,
    deliveryId: zaloResult.canonicalDeliveryId,
    interactionId: String(finalInteractionId || zaloResult.canonicalInteractionId),
    externalMessageId: zaloResult.externalMessageId,
    providerStatus: 'SENT',
    provenance,
  };
}

// ==============================================================================
// 7. FACEBOOK CANONICAL PATH (binding() + Pre-Dispatch Guard + dispatchMessage)
// ==============================================================================

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
    content, claimId, decision, provenance, model: _model, client,
  } = params;

  const admin = client || createAdminClient();

  // 1. Resolve canonical Facebook config via binding()
  const fbConfig = await dispatchFacebookCanonical({ companyId, conversationId, client });
  if ('status' in fbConfig) {
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

  // 2. Authoritative Pre-Dispatch DB Guard (Blocker B)
  const { data: guardRows, error: guardErr } = await admin.rpc(
    'guard_ai_pre_dispatch' as never,
    {
      p_company_id: companyId,
      p_conversation_id: conversationId,
      p_customer_id: customerId,
      p_window_id: windowId,
      p_ai_claim_id: claimId,
      p_channel: 'FACEBOOK',
      p_lease_seconds: 120,
    } as never
  );

  const guard = ((guardRows as unknown) as GuardPreDispatchRow[] | null)?.[0];
  if (guardErr || !guard) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Pre-dispatch guard query failed: ${guardErr?.message || 'No row'}`,
      provenance,
    };
  }

  if (!guard.granted) {
    if (guard.reason === 'SALE_ALREADY_RESPONDED') {
      return {
        success: false,
        claimed: true,
        decision: 'SALE_ALREADY_RESPONDED',
        windowId,
        conversationId,
        error: 'Dispatch denied: Sale has already responded to this customer',
        provenance,
      };
    }
    if (guard.reason === 'ALREADY_SENT') {
      return {
        success: true,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        interactionId: guard.interaction_id ?? undefined,
        externalMessageId: guard.provider_msg_id ?? undefined,
        providerStatus: 'SENT',
        provenance,
      };
    }
    if (guard.reason === 'PENDING_FINALIZE') {
      // Provider accepted previously: only finalize DB state without calling provider (Blocker C)
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
        deliveryId: guard.delivery_id ?? '',
        providerMid: guard.provider_msg_id ?? '',
      });
    }
    if (guard.reason === 'UNCERTAIN') {
      return {
        success: false,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        providerStatus: 'UNCERTAIN',
        error: 'Dispatch denied: Outbound delivery is in UNCERTAIN state',
        provenance,
      };
    }
    if (guard.reason === 'BUSY') {
      return {
        success: false,
        claimed: true,
        decision,
        windowId,
        conversationId,
        providerStatus: 'UNKNOWN',
        error: 'Dispatch denied: Another worker is currently dispatching',
        provenance,
      };
    }
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Pre-dispatch guard denied: ${guard.reason}`,
      provenance,
    };
  }

  const deliveryId = String(guard.delivery_id);
  const dispatchToken = guard.dispatch_token;

  // 3. Dispatch via canonical Facebook transport
  const fbResult = await dispatchMessage({
    page: fbConfig.pageId,
    recipient: fbConfig.recipientPsid,
    version: fbConfig.version,
    token: fbConfig.token,
    content,
  });

  // 4. Persist provider outcome immediately in durable RPC (Blocker C & D)
  if (fbResult.status === 'SENT' && fbResult.mid) {
    await admin.rpc(
      'record_ai_outbound_provider_result' as never,
      {
        p_company_id: companyId,
        p_delivery_id: deliveryId,
        p_outcome: 'SENT',
        p_dispatch_token: dispatchToken,
        p_provider_msg_id: fbResult.mid,
      } as never
    );

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
      deliveryId,
      providerMid: fbResult.mid,
    });
  }

  if (fbResult.status === 'FAILED') {
    await admin.rpc(
      'record_ai_outbound_provider_result' as never,
      {
        p_company_id: companyId,
        p_delivery_id: deliveryId,
        p_outcome: 'FAILED',
        p_dispatch_token: dispatchToken,
        p_error_message: 'Facebook dispatch failed',
      } as never
    );

    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      deliveryId,
      providerStatus: 'FAILED',
      error: 'Facebook dispatch failed with status FAILED',
      provenance,
    };
  }

  // UNKNOWN or UNCERTAIN: preserve outcome without downgrading to FAILED (Blocker D)
  await admin.rpc(
    'record_ai_outbound_provider_result' as never,
    {
      p_company_id: companyId,
      p_delivery_id: deliveryId,
      p_outcome: 'UNCERTAIN',
      p_dispatch_token: dispatchToken,
      p_error_message: `Facebook dispatch status ${fbResult.status}`,
    } as never
  );

  return {
    success: false,
    claimed: true,
    decision,
    windowId,
    conversationId,
    deliveryId,
    providerStatus: 'UNCERTAIN',
    error: `Facebook dispatch status is UNCERTAIN: ${fbResult.status}`,
    provenance,
  };
}

// ==============================================================================
// 8. TEST PATH: providerSender override (with durable state machine)
// ==============================================================================

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
  client?: SupabaseClient;
}): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    companyId, conversationId, customerId, windowId, channel,
    content, claimId, decision, provenance, providerSender, client,
  } = params;

  const admin = client || createAdminClient();

  // Authoritative Pre-Dispatch DB Guard (Blocker B)
  const { data: guardRows, error: guardErr } = await admin.rpc(
    'guard_ai_pre_dispatch' as never,
    {
      p_company_id: companyId,
      p_conversation_id: conversationId,
      p_customer_id: customerId,
      p_window_id: windowId,
      p_ai_claim_id: claimId,
      p_channel: channel,
      p_lease_seconds: 120,
    } as never
  );

  const guard = ((guardRows as unknown) as GuardPreDispatchRow[] | null)?.[0];
  if (guardErr || !guard) {
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Pre-dispatch guard query failed: ${guardErr?.message || 'No row'}`,
      provenance,
    };
  }

  if (!guard.granted) {
    if (guard.reason === 'SALE_ALREADY_RESPONDED') {
      return {
        success: false,
        claimed: true,
        decision: 'SALE_ALREADY_RESPONDED',
        windowId,
        conversationId,
        error: 'Dispatch denied: Sale has already responded to this customer',
        provenance,
      };
    }
    if (guard.reason === 'ALREADY_SENT') {
      return {
        success: true,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        interactionId: guard.interaction_id ?? undefined,
        externalMessageId: guard.provider_msg_id ?? undefined,
        providerStatus: 'SENT',
        provenance,
      };
    }
    if (guard.reason === 'PENDING_FINALIZE') {
      // Reconcile pending finalization without calling providerSender again
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
        deliveryId: guard.delivery_id ?? '',
        providerMid: guard.provider_msg_id ?? '',
      });
    }
    if (guard.reason === 'UNCERTAIN') {
      return {
        success: false,
        claimed: true,
        decision,
        windowId,
        conversationId,
        deliveryId: guard.delivery_id ?? undefined,
        providerStatus: 'UNCERTAIN',
        error: 'Dispatch denied: Outbound delivery is in UNCERTAIN state',
        provenance,
      };
    }
    if (guard.reason === 'BUSY') {
      return {
        success: false,
        claimed: true,
        decision,
        windowId,
        conversationId,
        providerStatus: 'UNKNOWN',
        error: 'Dispatch denied: Another worker is currently dispatching',
        provenance,
      };
    }
    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      error: `Pre-dispatch guard denied: ${guard.reason}`,
      provenance,
    };
  }

  const deliveryId = String(guard.delivery_id);
  const dispatchToken = guard.dispatch_token;

  // Invoke injected provider sender
  const providerResult = await providerSender({
    companyId,
    conversationId,
    customerId,
    channel,
    content,
    deliveryId,
  });

  // Persist provider outcome immediately in durable RPC (Blocker C & D)
  if (providerResult.status === 'SENT' && providerResult.externalMessageId) {
    await admin.rpc(
      'record_ai_outbound_provider_result' as never,
      {
        p_company_id: companyId,
        p_delivery_id: deliveryId,
        p_outcome: 'SENT',
        p_dispatch_token: dispatchToken,
        p_provider_msg_id: providerResult.externalMessageId,
      } as never
    );

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
      deliveryId,
      providerMid: providerResult.externalMessageId,
    });
  }

  if (providerResult.status === 'FAILED') {
    await admin.rpc(
      'record_ai_outbound_provider_result' as never,
      {
        p_company_id: companyId,
        p_delivery_id: deliveryId,
        p_outcome: 'FAILED',
        p_dispatch_token: dispatchToken,
        p_error_message: providerResult.error || 'Provider rejected delivery',
      } as never
    );

    return {
      success: false,
      claimed: true,
      decision,
      windowId,
      conversationId,
      deliveryId,
      providerStatus: 'FAILED',
      error: providerResult.error || 'Provider delivery failed',
      provenance,
    };
  }

  // UNKNOWN or UNCERTAIN: preserve state without downgrading to FAILED (Blocker D)
  await admin.rpc(
    'record_ai_outbound_provider_result' as never,
    {
      p_company_id: companyId,
      p_delivery_id: deliveryId,
      p_outcome: 'UNCERTAIN',
      p_dispatch_token: dispatchToken,
      p_error_message: providerResult.error || `Provider returned ${providerResult.status}`,
    } as never
  );

  return {
    success: false,
    claimed: true,
    decision,
    windowId,
    conversationId,
    deliveryId,
    providerStatus: 'UNCERTAIN',
    error: providerResult.error || `Provider returned status ${providerResult.status}`,
    provenance,
  };
}

// ==============================================================================
// 9. SHARED ATOMIC FINALIZATION (Facebook + test paths)
// ==============================================================================

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
  deliveryId: string;
  providerMid: string;
}): Promise<ExecuteAiResponseRuntimeResult> {
  const {
    admin, companyId, conversationId, customerId, windowId,
    content, claimId, decision, provenance, deliveryId, providerMid,
  } = params;

  // Finalize confirmed delivery atomically via hardened RPC (Blocker F)
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
        model_version: provenance?.modelVersion,
        analysis_record_id: provenance?.analysisRecordId || null,
        sales_style_profile_id: provenance?.salesStyleProfileId,
        is_neutral_default: provenance?.isNeutralDefault,
        ai_claim_id: claimId,
        window_id: windowId,
        delivery_id: deliveryId,
        command_id: windowId,
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
      providerStatus: 'SENT',
      error: `Failed to finalize delivery atomically: ${finalizeErr?.message}`,
      provenance,
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
    providerStatus: 'SENT',
    provenance,
  };
}
