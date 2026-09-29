import 'server-only';

import { createAdminClient } from '../../../lib/supabase/admin';
import type {
  CompleteSurveyInput,
  SurveyValidationResult,
  MeasurementData,
  GateType,
  MountingMethod,
} from '../types/survey';

import {
  validateSurveyInput,
  sanitizeSurveyInput,
} from '../validations/survey.schema';
import { verifyMandatoryPhotosInStorage } from './storage-upload.service';

/**
 * Formal Validation Gate: Prevents partial/incomplete surveys from entering DB.
 * Guarantees Member 7 (TV7) has 100% required technical measurements to calculate price
 * without triggering 'NEED_INFO' status.
 */
export function validateSurveyCompletionGate(
  input: CompleteSurveyInput
): SurveyValidationResult {
  return validateSurveyInput(input);
}

export interface CompleteSurveyResult {
  success: boolean;
  surveyId?: string;
  message?: string;
  missingFields?: string[];
  errors?: Record<string, string>;
  isExisting?: boolean;
}

/**
 * Service: Finalize Survey & Register Formal Record in Supabase
 * - Validates input against validation gate
 * - Idempotency: Returns existing survey if already created for this appointment
 * - Checks appointment status (must be IN_PROGRESS or ACCEPTED; rejects CANCELLED)
 * - Strips ephemeral Signed URLs, storing only canonical references
 * - Atomic: Inserts survey and updates appointment to COMPLETED; rolls back survey on failure
 */
export async function completeSurvey(
  input: CompleteSurveyInput,
  completedByUserId: string,
  companyId: string,
  client?: import('@supabase/supabase-js').SupabaseClient
): Promise<CompleteSurveyResult> {
  const adminClient = client || createAdminClient();

  // 2. Fetch and verify appointment
  const { data: appointment, error: aptError } = await adminClient
    .from('appointments')
    .select('id, company_id, customer_id, assignee_id, status, type')
    .eq('id', input.appointmentId)
    .maybeSingle();

  if (aptError || !appointment) {
    return {
      success: false,
      message: 'Không tìm thấy thông tin lịch hẹn khảo sát.',
    };
  }

  if (appointment.company_id !== companyId) {
    return {
      success: false,
      message: 'Lịch hẹn không thuộc doanh nghiệp của bạn.',
    };
  }

  // Tự phòng vệ (fail-closed) độc lập ở tầng service: Chỉ cho phép hoàn tất lịch hẹn loại SURVEY
  if (appointment.type !== 'SURVEY') {
    throw new Error('Lịch hẹn không phải loại SURVEY.');
  }

  if (appointment.assignee_id !== completedByUserId) {
    return { success: false, message: 'Bạn không có quyền hoàn tất khảo sát này.' };
  }

  // Re-authorized by the RPC against active profile/member and original completed_by.
  // Return only a receipt; no survey data or storage reference is exposed on retry.
  if (appointment.status === 'COMPLETED') {
    const { data, error } = await adminClient.rpc('complete_survey_atomic', {
      p_appointment_id: appointment.id, p_completed_by: completedByUserId, p_survey_payload: {},
    });
    if (error || !data?.id || data.isExisting !== true) {
      console.error('[Survey completion reconciliation]', { appointmentId: appointment.id, code: error?.code });
      return { success: false, message: 'Không thể xác nhận khảo sát đã hoàn tất. Cần kiểm tra lại dữ liệu.' };
    }
    return { success: true, surveyId: data.id, isExisting: true };
  }
  if (!['ACCEPTED', 'IN_PROGRESS'].includes(appointment.status)) {
    return { success: false, message: 'Lịch hẹn không ở trạng thái ACCEPTED hoặc IN_PROGRESS.' };
  }
  const validation = validateSurveyCompletionGate(input);
  if (!validation.isValid) return {
    success: false, message: 'Dữ liệu khảo sát chưa đạt yêu cầu kỹ thuật.',
    missingFields: validation.missingFields, errors: validation.errors,
  };
  const sanitizedInput = sanitizeSurveyInput(input);

  // 3. Xác thực ảnh thực tế từ Server Storage - KHÔNG tin mảng photos do browser tự gửi
  const storageVerification = await verifyMandatoryPhotosInStorage(
    {
      companyId: appointment.company_id,
      customerId: appointment.customer_id,
      appointmentId: appointment.id,
    },
    adminClient
  );

  if (!storageVerification.isValid) {
    return {
      success: false,
      message: 'Thiếu ảnh hiện trường bắt buộc trong kho lưu trữ.',
      missingFields: storageVerification.missingSlots.map((s) => `photos.${s}`),
    };
  }

  // Dữ liệu ghi vào trường photos của bảng surveys là danh sách tệp được xác thực từ storage này
  const sanitizedPhotosArray = storageVerification.photos;

  const rawM = sanitizedInput.measurements;
  const measurementsPayload: MeasurementData = {
    clear_width_mm: Number(rawM.clear_width_mm ?? rawM.clearWidthMm),
    barrier_height_mm: Number(rawM.barrier_height_mm ?? rawM.waterHeightMm ?? rawM.barrierHeightMm),
    anticipated_flood_height_mm: Number(
      rawM.anticipated_flood_height_mm ??
        rawM.anticipatedFloodHeightMm
    ),
    step_height_mm:
      rawM.step_height_mm !== undefined
        ? Number(rawM.step_height_mm)
        : rawM.stepHeightMm !== undefined
        ? Number(rawM.stepHeightMm)
        : undefined,
    width_top_mm: rawM.width_top_mm ? Number(rawM.width_top_mm) : undefined,
    width_bottom_mm: rawM.width_bottom_mm ? Number(rawM.width_bottom_mm) : undefined,
    gate_type: (rawM.gate_type || rawM.gateType) as GateType | undefined,
    mounting_method: (rawM.mounting_method || rawM.mountingMethod) as MountingMethod | undefined,
  };

  // Structured readable text string for public.surveys.site_condition (text NOT NULL column)
  const rawS = sanitizedInput.siteCondition;
  const siteConditionText = JSON.stringify({
    wall_material: rawS.wall_material || rawS.wallMaterial || null,
    floor_material: rawS.floor_material || rawS.floorMaterial || null,
    floor_evenness: rawS.floor_evenness || rawS.floorEvenness || null,
    slope_grade: rawS.slope_grade || rawS.slopeGrade || null,
    notes: rawS.notes || sanitizedInput.notes || '',
    specialRequirements: rawS.specialRequirements || null,
  });

  const notes = sanitizedInput.notes || rawS.notes || null;

  // 4. Atomic Single-Shot Survey Completion qua PostgreSQL RPC function
  // Đảm bảo lock dòng appointment FOR UPDATE, update status sang COMPLETED và insert survey trong duy nhất 1 transaction
  const payload = {
    measurements: measurementsPayload,
    photos: sanitizedPhotosArray,
    site_condition: siteConditionText,
    notes,
  };

  const { data: rpcData, error: rpcError } = await adminClient.rpc(
    'complete_survey_atomic',
    {
      p_appointment_id: sanitizedInput.appointmentId,
      p_completed_by: completedByUserId,
      p_survey_payload: payload,
    }
  );

  if (rpcError) {
    if (rpcError.message?.includes('INVALID_COMPLETED_BY')) {
      throw new Error(
        'INVALID_COMPLETED_BY: Người thực hiện khảo sát không phải là nhân sự hợp lệ của doanh nghiệp.'
      );
    }

    if (
      rpcError.message?.includes('INVALID_PREDECESSOR_STATE') ||
      rpcError.message?.includes('APPOINTMENT_STATE_INVALID')
    ) {
      throw new Error(
        'INVALID_PREDECESSOR_STATE: Lịch hẹn chưa ở trạng thái đang thực hiện (IN_PROGRESS/ACCEPTED), không thể hoàn tất khảo sát.'
      );
    }

    if (
      rpcError.message?.includes('APPOINTMENT_ALREADY_TERMINAL') ||
      rpcError.message?.includes('CANCELLED') ||
      /\bCOMPLETED\b/.test(rpcError.message || '')
    ) {
      throw new Error(
        'APPOINTMENT_ALREADY_TERMINAL: Lịch hẹn đã ở trạng thái kết thúc hoặc bị hủy, không thể hoàn tất khảo sát.'
      );
    }

    if (
      rpcError.code === '23505' ||
      rpcError.message?.includes('unique_survey_appointment') ||
      rpcError.message?.includes('SURVEY_ALREADY_EXISTS') ||
      rpcError.message?.includes('duplicate key')
    ) {
      throw new Error('SURVEY_ALREADY_EXISTS: Khảo sát cho lịch hẹn này đã tồn tại.');
    }

    if (rpcError.message?.includes('APPOINTMENT_NOT_FOUND')) {
      throw new Error('APPOINTMENT_NOT_FOUND: Không tìm thấy thông tin lịch hẹn khảo sát.');
    }

    if (rpcError.message?.includes('APPOINTMENT_TYPE_NOT_SURVEY')) {
      throw new Error('APPOINTMENT_TYPE_NOT_SURVEY: Lịch hẹn không phải là lịch khảo sát hợp lệ.');
    }

    return {
      success: false,
      message: 'Không thể cập nhật trạng thái lịch hẹn, đã hủy thao tác tạo khảo sát.',
    };
  }

  const createdSurvey = rpcData as { id?: string; isExisting?: boolean } | null;

  if (!createdSurvey?.id) return { success: false, message: 'Không thể xác nhận kết quả khảo sát.' };
  return {
    success: true,
    isExisting: createdSurvey.isExisting === true,
    surveyId: createdSurvey.id,
    message: 'Khảo sát đã được hoàn tất và chuyển giao dữ liệu kỹ thuật thành công.',
  };
}

// Re-export Pricing Adapter functions for TV7: Price Calculation
export {
  formatSurveyForPricing,
  getSurveyForPricing,
} from '../adapters/pricing.adapter';

/**
 * Authorizes actor and executes atomic survey completion.
 * Encapsulates createAdminClient call inside domain service layer.
 */
export async function executeSurveyCompletion(
  input: CompleteSurveyInput
): Promise<CompleteSurveyResult> {
  const { getActorContext } = await import('../../../lib/auth/context');
  const adminClient = createAdminClient();
  const { data: appointment, error } = await adminClient
    .from('appointments')
    .select('id, company_id, assignee_id, type, status')
    .eq('id', input.appointmentId)
    .maybeSingle();

  if (error || !appointment) {
    throw new Error('Không tìm thấy lịch hẹn khảo sát.');
  }

  const actor = await getActorContext(appointment.company_id);
  if (
    !actor ||
    actor.profileStatus !== 'ACTIVE' ||
    actor.membershipStatus !== 'ACTIVE' ||
    actor.role !== 'TECHNICIAN' ||
    actor.companyId !== appointment.company_id ||
    actor.userId !== appointment.assignee_id ||
    appointment.type !== 'SURVEY'
  ) {
    throw new Error('Bạn không có quyền hoàn tất khảo sát này.');
  }

  return completeSurvey(input, actor.userId, actor.companyId!);
}
