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
  // 1. Enforce Validation Gate & Text Sanitization
  const validation = validateSurveyCompletionGate(input);
  if (!validation.isValid) {
    return {
      success: false,
      message: 'Không thể hoàn tất khảo sát: Còn thiếu thông tin kỹ thuật hoặc ảnh bắt buộc.',
      missingFields: validation.missingFields,
      errors: validation.errors,
    };
  }

  const sanitizedInput = sanitizeSurveyInput(input);
  const adminClient = client || createAdminClient();

  // 2. Fetch and verify appointment
  const { data: appointment, error: aptError } = await adminClient
    .from('appointments')
    .select('id, company_id, customer_id, assignee_id, status, type')
    .eq('id', sanitizedInput.appointmentId)
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

  // Kiểm tra trạng thái hiện tại của appointment
  if (appointment.status === 'CANCELLED') {
    return {
      success: false,
      message: 'Lịch hẹn đã bị hủy, không thể hoàn tất khảo sát.',
    };
  }

  if (appointment.status !== 'IN_PROGRESS' && appointment.status !== 'ACCEPTED') {
    return {
      success: false,
      message: `Lịch hẹn đang ở trạng thái ${appointment.status}, không thể hoàn tất khảo sát. Chỉ chấp nhận trạng thái IN_PROGRESS hoặc ACCEPTED.`,
    };
  }

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
        rawM.anticipatedFloodHeightMm ??
        rawM.barrier_height_mm ??
        rawM.waterHeightMm
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
  const completedAt = new Date().toISOString();

  // 4. Atomic Single-Shot Survey Completion qua PostgreSQL RPC function
  // Đảm bảo lock dòng appointment FOR UPDATE, update status sang COMPLETED và insert survey trong duy nhất 1 transaction
  const payload = {
    company_id: companyId,
    customer_id: appointment.customer_id,
    completed_by: completedByUserId,
    measurements: measurementsPayload,
    photos: sanitizedPhotosArray,
    site_condition: siteConditionText,
    notes,
    completed_at: completedAt,
  };

  const { data: rpcData, error: rpcError } = await adminClient.rpc(
    'complete_survey_atomic',
    {
      p_appointment_id: sanitizedInput.appointmentId,
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

  const createdSurvey = rpcData as { id?: string } | null;

  return {
    success: true,
    surveyId: createdSurvey?.id,
    message: 'Khảo sát đã được hoàn tất và chuyển giao dữ liệu kỹ thuật thành công.',
  };
}

// Re-export Pricing Adapter functions for TV7: Price Calculation
export {
  formatSurveyForPricing,
  getSurveyForPricing,
} from '../adapters/pricing.adapter';

