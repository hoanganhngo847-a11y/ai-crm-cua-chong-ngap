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
  const priceRegex = /\b\d+(?:[\.,]\d+)?\s*(?:triệu|nghìn|tr|k|vnđ|vnd|đ|đồng|usd|\$)(?:\s*\/\s*(?:m2|m|bộ))?\b/i;
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
// 3. OUTBOUND PROVIDER TYPES & REAL DISPATCHER
// ==============================================================================

export interface OutboundProviderResult {
  status: 'SENT' | 'FAILED' | 'UNKNOWN' | 'UNCERTAIN';
  externalMessageId?: string;
  error?: string;
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
 * Production channel dispatcher: executes real provider delivery based on channel.
 * Never synthesizes SENT; fails closed if channel unconfigured.
 */
export async function dispatchRealChannelOutbound(params: {
  companyId: string;
  conversationId: string;
  customerId: string;
  channel: string;
  content: string;
  client?: SupabaseClient;
}): Promise<OutboundProviderResult> {
  const { companyId, conversationId, channel, content, client = createAdminClient() } = params;

  if (channel === 'FACEBOOK') {
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

    const token =
      process.env[`FACEBOOK_PAGE_ACCESS_TOKEN_${pageId}`] ||
      process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
      '';
    const version = process.env.META_GRAPH_VERSION || 'v20.0';

    if (!token.trim()) {
      return { status: 'FAILED', error: 'FACEBOOK_NOT_CONFIGURED' };
    }

    const fbResult = await dispatchMessage({
      page: pageId,
      recipient: recipientPsid,
      version,
      token,
      content,
    });

    if (fbResult.status === 'SENT' && fbResult.mid) {
      return {
        status: 'SENT',
        externalMessageId: fbResult.mid,
      };
    }

    return {
      status: fbResult.status,
      error: `Facebook dispatch failed with status ${fbResult.status}`,
    };
  }

  if (channel === 'ZALO') {
    // Check Zalo configuration
    const zaloToken = process.env.ZALO_OA_ACCESS_TOKEN || '';
    if (!zaloToken.trim()) {
      return { status: 'FAILED', error: 'ZALO_NOT_CONFIGURED' };
    }

    // In a real Zalo deployment, retrieve Zalo UID from identities table
    const { data: identity } = await client
      .from('identities')
      .select('identifier')
      .eq('company_id', companyId)
      .eq('customer_id', params.customerId)
      .eq('channel', 'ZALO')
      .maybeSingle();

    if (!identity?.identifier) {
      return { status: 'FAILED', error: 'MISSING_ZALO_RECIPIENT_UID' };
    }

    // Attempt real Zalo API send
    try {
      const response = await fetch('https://openapi.zalo.me/v3.0/oa/message/cs', {
        method: 'POST',
        headers: {
          access_token: zaloToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { user_id: identity.identifier },
          message: { text: content },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        const payload = await response.json();
        if (payload.error === 0 && payload.data?.message_id) {
          return {
            status: 'SENT',
            externalMessageId: String(payload.data.message_id),
          };
        }
      }
      return { status: 'FAILED', error: 'Zalo message rejected by API' };
    } catch (err: unknown) {
      return { status: 'FAILED', error: (err as Error).message || 'Zalo network error' };
    }
  }

  // Unsupported or unconfigured channel: FAIL CLOSED
  return {
    status: 'FAILED',
    error: `PROVIDER_NOT_CONFIGURED: Channel "${channel}" has no configured provider transport`,
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
 * -> Canonical Pending Outbound Delivery (outbound_deliveries)
 * -> Channel-Specific Provider Dispatcher
 * -> Provider Delivery Confirmation (SENT only)
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

  // Step 8: Create Canonical Pending Outbound Delivery in outbound_deliveries
  // (NO public.interactions row exists yet — preserves AI Claim != AI Sent)
  const admin = createAdminClient();
  const { data: deliveryId, error: deliveryErr } = await admin.rpc('create_ai_outbound_delivery_pending' as never, {
    p_company_id: companyId,
    p_conversation_id: conversationId,
    p_channel: conv.channel,
    p_client_command_id: claimResult.claimId,
    p_request_fingerprint: `${companyId}:${conversationId}:${claimResult.claimId}`,
  } as never);

  if (deliveryErr || !deliveryId) {
    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      error: `Failed to create pending outbound delivery: ${deliveryErr?.message}`,
    };
  }

  // Step 9: Channel-Specific Provider Dispatcher
  let providerResult: OutboundProviderResult;
  if (providerSender) {
    providerResult = await providerSender({
      companyId,
      conversationId,
      customerId,
      channel: conv.channel,
      content: rawGeneratedText,
      deliveryId: String(deliveryId),
    });
  } else {
    // Production default: real channel dispatcher (Facebook / Zalo).
    // Fails closed if channel is unconfigured. Never synthesizes SENT!
    providerResult = await dispatchRealChannelOutbound({
      companyId,
      conversationId,
      customerId,
      channel: conv.channel,
      content: rawGeneratedText,
      client: admin,
    });
  }

  // Step 10: Provider Result Evaluation (Fail-Closed on FAILED / UNKNOWN / UNCERTAIN)
  // If provider does not confirm SENT with provider message ID:
  // - Mark delivery FAILED in outbound_deliveries
  // - ZERO rows inserted in public.interactions (no false sent message visible!)
  // - SLA remains OPEN for human intervention
  if (providerResult.status !== 'SENT' || !providerResult.externalMessageId) {
    await admin.rpc('record_ai_outbound_delivery_failed' as never, {
      p_company_id: companyId,
      p_delivery_id: deliveryId,
      p_error_message: providerResult.error || `Provider delivery status: ${providerResult.status}`,
    } as never);

    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      deliveryId: String(deliveryId),
      providerStatus: providerResult.status,
      error: providerResult.error || `Provider delivery failed with status ${providerResult.status}`,
      provenance: {
        modelVersion: model.modelVersion,
        analysisRecordId: analysisRecord?.id || null,
        salesStyleProfileId: styleContext.activeProfileId,
        isNeutralDefault: styleContext.isNeutralDefault,
        aiClaimId: claimResult.claimId,
      },
    };
  }

  // Step 11: Finalize Confirmed Delivery in Database Atomically
  // Atomic RPC: finalize_ai_outbound_delivery_atomic
  // - Creates public.interactions (actor_type = 'AI', external_ref = provider_msg_id)
  // - Saves mandatory provenance in private raw contents table via trusted RPC (Fail-Closed!)
  // - Updates outbound_deliveries to SENT with interaction_id link
  // - Resolves Response SLA window to AI_RESPONDED
  // - Resets conversation status to OPEN
  const { data: finalizedInteractionId, error: finalizeErr } = await admin.rpc(
    'finalize_ai_outbound_delivery_atomic' as never,
    {
      p_company_id: companyId,
      p_delivery_id: deliveryId,
      p_conversation_id: conversationId,
      p_customer_id: customerId,
      p_window_id: windowId,
      p_ai_claim_id: claimResult.claimId,
      p_provider_msg_id: providerResult.externalMessageId,
      p_sanitized_content: rawGeneratedText,
      p_raw_content: rawGeneratedText,
      p_source_metadata: {
        source: 'ai_response_runtime',
        model_version: model.modelVersion,
        analysis_record_id: analysisRecord?.id || null,
        sales_style_profile_id: styleContext.activeProfileId,
        is_neutral_default: styleContext.isNeutralDefault,
        ai_claim_id: claimResult.claimId,
        window_id: windowId,
        delivery_id: deliveryId,
      },
    } as never
  );

  if (finalizeErr || !finalizedInteractionId) {
    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      deliveryId: String(deliveryId),
      providerStatus: providerResult.status,
      error: `Failed to finalize delivery atomically: ${finalizeErr?.message}`,
    };
  }

  return {
    success: true,
    claimed: true,
    decision: claimResult.decision,
    windowId,
    conversationId,
    deliveryId: String(deliveryId),
    interactionId: String(finalizedInteractionId),
    externalMessageId: providerResult.externalMessageId,
    providerStatus: providerResult.status,
    provenance: {
      modelVersion: model.modelVersion,
      analysisRecordId: analysisRecord?.id || null,
      salesStyleProfileId: styleContext.activeProfileId,
      isNeutralDefault: styleContext.isNeutralDefault,
      aiClaimId: claimResult.claimId,
    },
  };
}
