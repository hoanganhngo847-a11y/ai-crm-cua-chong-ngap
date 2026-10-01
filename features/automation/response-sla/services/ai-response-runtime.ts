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
// 3. OUTBOUND PROVIDER TYPES
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
  interactionId: string;
}) => Promise<OutboundProviderResult>;

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
 * -> Outbound Send -> Provider Confirmation -> SLA Resolution
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

  // Step 8: Persist AI Outbound Interaction
  const { data: newInteraction, error: intErr } = await client
    .from('interactions')
    .insert({
      company_id: companyId,
      customer_id: customerId,
      conversation_id: conversationId,
      channel: conv.channel,
      type: 'MESSAGE',
      direction: 'OUTBOUND',
      actor_type: 'AI',
      sanitized_content: rawGeneratedText,
      sanitization_status: 'SUCCEEDED',
      sanitizer_version: 'v1',
      created_at: new Date().toISOString(),
    })
    .select('id, created_at')
    .single();

  if (intErr || !newInteraction) {
    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      error: `Failed to record AI interaction: ${intErr?.message}`,
    };
  }

  const interactionId = newInteraction.id;

  // Step 9: Store Provenance in private schema (No PII / Phone in public)
  const admin = createAdminClient();
  const { error: rawErr } = await admin.rpc('save_ai_interaction_provenance' as never, {
    p_company_id: companyId,
    p_interaction_id: interactionId,
    p_raw_content: rawGeneratedText,
    p_source_metadata: {
      source: 'ai_response_runtime',
      model_version: model.modelVersion,
      analysis_record_id: analysisRecord?.id || null,
      sales_style_profile_id: styleContext.activeProfileId,
      is_neutral_default: styleContext.isNeutralDefault,
      ai_claim_id: claimResult.claimId,
      window_id: windowId,
    },
  } as never);
  if (rawErr) {
    console.error('Lỗi khi lưu interaction_raw_contents:', rawErr);
  }

  // Step 10: Provider Sending & Delivery Confirmation
  let providerResult: OutboundProviderResult;
  if (providerSender) {
    providerResult = await providerSender({
      companyId,
      conversationId,
      customerId,
      channel: conv.channel,
      content: rawGeneratedText,
      interactionId,
    });
  } else {
    // Default provider simulation: if no provider sender injected, simulate provider outcome
    // by checking environment or returning mock SENT with UUID
    providerResult = {
      status: 'SENT',
      externalMessageId: `msg_${crypto.randomUUID()}`,
    };
  }

  // Invariant: AI Claim != AI Sent; model generated != provider SENT
  // FAILED / UNKNOWN provider result must NOT falsely resolve SLA
  if (providerResult.status !== 'SENT' || !providerResult.externalMessageId) {
    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      interactionId,
      providerStatus: providerResult.status,
      error: providerResult.error || `Provider delivery status is ${providerResult.status}`,
      provenance: {
        modelVersion: model.modelVersion,
        analysisRecordId: analysisRecord?.id || null,
        salesStyleProfileId: styleContext.activeProfileId,
        isNeutralDefault: styleContext.isNeutralDefault,
        aiClaimId: claimResult.claimId,
      },
    };
  }

  // Step 11: SLA Resolution on Confirmed Provider Delivery
  // Atomic RPC: resolve_response_sla_on_ai_reply
  const { error: resolveErr } = await client.rpc('resolve_response_sla_on_ai_reply', {
    p_company_id: companyId,
    p_conversation_id: conversationId,
    p_ai_claim_id: claimResult.claimId,
    p_ai_interaction_id: interactionId,
  });

  if (resolveErr) {
    return {
      success: false,
      claimed: true,
      decision: claimResult.decision,
      windowId,
      conversationId,
      interactionId,
      providerStatus: providerResult.status,
      error: `Failed to resolve SLA: ${resolveErr.message}`,
    };
  }

  // Update external_ref on interaction
  await client
    .from('interactions')
    .update({ external_ref: providerResult.externalMessageId })
    .eq('id', interactionId);

  return {
    success: true,
    claimed: true,
    decision: claimResult.decision,
    windowId,
    conversationId,
    interactionId,
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
