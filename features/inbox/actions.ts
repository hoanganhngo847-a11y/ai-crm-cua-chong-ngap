'use server';

import { getActorContext, requireCompanyRole } from '../../lib/auth/context';
import { APPLICATION_ROLES } from '../../shared/constants/roles';
import { createAdminClient } from '../../lib/supabase/admin';
import {
  executeCustomerAnalysis,
  NoAnalyzableSourcesError,
} from '../ai-analysis/services/analysis-worker';
import {
  buildRuntimeSalesStyleContext,
} from '../sales-style/services/runtime-style-context';
import {
  OpenAiResponseModel,
  validateAiResponsePolicyFirewall,
} from '../automation/response-sla/services/ai-response-runtime';

export interface GenerateAiDraftSuggestionResult {
  success: boolean;
  suggestion?: string;
  isNeutralDefault?: boolean;
  styleProfileId?: string | null;
  analysisSummary?: string | null;
  error?: string;
}

/**
 * Server Action: Tạo gợi ý phản hồi AI cho chuyên viên Sale trong Inbox
 * - Không gửi tin nhắn ra bên ngoài
 * - Không ghi nhận interaction là đã gửi
 * - Áp dụng Sales Style và Customer Analysis đã qua kiểm duyệt bảo mật
 */
export async function generateAiDraftSuggestionAction(params: {
  conversationId: string;
}): Promise<GenerateAiDraftSuggestionResult> {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức.' };
    }

    await requireCompanyRole(actor.companyId, [
      APPLICATION_ROLES.BOSS_ADMIN,
      APPLICATION_ROLES.SALE,
    ]);

    const admin = createAdminClient();

    // 1. Lấy thông tin cuộc hội thoại
    const { data: conv, error: convErr } = await admin
      .from('conversations')
      .select('id, customer_id, channel, assigned_to')
      .eq('company_id', actor.companyId)
      .eq('id', params.conversationId)
      .single();

    if (convErr || !conv) {
      return { success: false, error: 'Không tìm thấy cuộc hội thoại.' };
    }

    // 2. Lấy tin nhắn gần nhất của khách hàng
    const { data: latestInbound } = await admin
      .from('interactions')
      .select('sanitized_content')
      .eq('company_id', actor.companyId)
      .eq('conversation_id', params.conversationId)
      .eq('direction', 'INBOUND')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const customerMessage = latestInbound?.sanitized_content || 'Chào công ty, tôi quan tâm cửa chống ngập';

    // 3. Phân tích khách hàng (xử lý gracefully)
    let analysisSummary: string | null = null;
    try {
      const analysis = await executeCustomerAnalysis({
        companyId: actor.companyId,
        customerId: conv.customer_id,
        client: admin,
      });
      analysisSummary = analysis.summary;
    } catch (err: unknown) {
      if (!(err instanceof NoAnalyzableSourcesError)) {
        console.warn('AI analysis skipped for suggestion:', err);
      }
    }

    // 4. Sales Style Context
    const saleUserId = conv.assigned_to || (actor.role === 'SALE' ? actor.userId : null);
    const styleContext = await buildRuntimeSalesStyleContext({
      companyId: actor.companyId,
      saleUserId,
      client: admin,
    });

    // 5. Sinh phản hồi gợi ý
    const systemPrompt = [
      `Bạn là trợ lý AI hỗ trợ chuyên viên Sale soạn thảo câu trả lời cho khách hàng quan tâm cửa chống ngập.`,
      styleContext.styleContextPrompt,
      analysisSummary ? `[GHI CHÚ HÀNH TRÌNH KHÁCH HÀNG]: ${analysisSummary}` : '',
      `[YÊU CẦU]:`,
      `- Viết một câu trả lời hoàn chỉnh, súc tích, chuyên nghiệp.`,
      `- TUYỆT ĐỐI KHÔNG TỰ BÁO GIÁ CỤ THỂ, KHÔNG HỨA HẸN CHIẾT KHẤU, KHÔNG ĐÒI CHUYỂN KHOẢN.`,
      `- Đề xuất gửi hình ảnh hiện trường hoặc đặt lịch khảo sát đo đạc miễn phí tận nơi.`,
    ].filter(Boolean).join('\n\n');

    const model = new OpenAiResponseModel();
    const rawSuggestion = await model.generateResponse({
      systemPrompt,
      userPrompt: `Tin nhắn khách hàng: "${customerMessage}"`,
    });

    // 6. Kiểm tra Policy Firewall
    const check = validateAiResponsePolicyFirewall(rawSuggestion);
    if (!check.valid) {
      return {
        success: false,
        error: `Gợi ý vi phạm chính sách an toàn thương mại: ${check.violationReason}`,
      };
    }

    return {
      success: true,
      suggestion: rawSuggestion,
      isNeutralDefault: styleContext.isNeutralDefault,
      styleProfileId: styleContext.activeProfileId,
      analysisSummary,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi tạo gợi ý AI';
    return {
      success: false,
      error: message,
    };
  }
}
