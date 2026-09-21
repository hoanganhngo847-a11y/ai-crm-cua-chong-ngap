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

  // 3. Idempotent check: Tránh trùng lặp & Race Condition
  // Trước khi tạo survey mới, kiểm tra xem appointment này đã có bản ghi surveys nào chưa
  const { data: existingSurvey } = await adminClient
    .from('surveys')
    .select('id')
    .eq('appointment_id', sanitizedInput.appointmentId)
    .maybeSingle();

  if (existingSurvey) {
    return {
      success: true,
      surveyId: existingSurvey.id,
      isExisting: true,
      message: 'Khảo sát cho lịch hẹn này đã tồn tại.',
    };
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

  // 4. Xác thực ảnh thực tế từ Server Storage - KHÔNG tin mảng photos do browser tự gửi
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

  // 5. Insert Survey Record into Supabase
  const { data: insertedSurvey, error: insertError } = await adminClient
    .from('surveys')
    .insert({
      company_id: companyId,
      customer_id: appointment.customer_id,
      appointment_id: appointment.id,
      completed_by: completedByUserId,
      measurements: measurementsPayload,
      photos: sanitizedPhotosArray,
      site_condition: siteConditionText,
      notes,
      completed_at: completedAt,
    })
    .select('id')
    .single();

  if (insertError || !insertedSurvey) {
    return {
      success: false,
      message: `Lỗi ghi dữ liệu khảo sát: ${insertError?.message || 'Không rõ nguyên nhân'}`,
    };
  }

  // 6. Update Appointment status to 'COMPLETED' (Atomic check with rollback)
  const { error: updateAptError } = await adminClient
    .from('appointments')
    .update({
      status: 'COMPLETED',
      updated_at: completedAt,
    })
    .eq('id', appointment.id);

  if (updateAptError) {
    console.error('Lỗi cập nhật appointments, đang rollback bản ghi survey:', updateAptError);
    // Rollback: Xóa bản ghi survey vừa tạo theo newSurvey.id để giữ tính Atomic
    await adminClient.from('surveys').delete().eq('id', insertedSurvey.id);

    return {
      success: false,
      message: 'Không thể cập nhật trạng thái lịch hẹn, đã hủy thao tác tạo khảo sát.',
    };
  }

  return {
    success: true,
    surveyId: insertedSurvey.id,
    message: 'Khảo sát đã được hoàn tất và chuyển giao dữ liệu kỹ thuật thành công.',
  };
}

// Re-export Pricing Adapter functions for TV7: Price Calculation
export {
  formatSurveyForPricing,
  getSurveyForPricing,
} from '../adapters/pricing.adapter';

