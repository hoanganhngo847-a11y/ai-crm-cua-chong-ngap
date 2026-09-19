import 'server-only';

import { createAdminClient } from '../../../lib/supabase/admin';
import type {
  CompleteSurveyInput,
  SurveyValidationResult,
  SurveyPricingData,
  SurveyRecord,
  SurveyPhotoItem,
  MeasurementData,
  SiteConditionData,
  GateType,
  MountingMethod,
  WallMaterial,
  FloorMaterial,
  FloorEvenness,
  SlopeGrade,
} from '../types/survey';

/**
 * Formal Validation Gate: Prevents partial/incomplete surveys from entering DB.
 * Guarantees Member 7 (TV7) has 100% required technical measurements to calculate price
 * without triggering 'NEED_INFO' status.
 */
export function validateSurveyCompletionGate(
  input: CompleteSurveyInput
): SurveyValidationResult {
  const missingFields: string[] = [];
  const errors: Record<string, string> = {};

  const m = input.measurements;
  const s = input.siteCondition;
  const p = input.photos || {};

  // 1. Mandatory Geometric Measurements (> 0)
  if (!m.clear_width_mm || m.clear_width_mm <= 0) {
    missingFields.push('clear_width_mm');
    errors.clear_width_mm = 'Chiều rộng lọt lòng (clear_width_mm) bắt buộc phải lớn hơn 0 mm.';
  }

  if (!m.barrier_height_mm || m.barrier_height_mm <= 0) {
    missingFields.push('barrier_height_mm');
    errors.barrier_height_mm = 'Chiều cao tấm chắn đề xuất (barrier_height_mm) bắt buộc phải lớn hơn 0 mm.';
  }

  if (m.anticipated_flood_height_mm === undefined || m.anticipated_flood_height_mm <= 0) {
    missingFields.push('anticipated_flood_height_mm');
    errors.anticipated_flood_height_mm =
      'Cao độ đỉnh ngập dự kiến (anticipated_flood_height_mm) bắt buộc phải lớn hơn 0 mm.';
  }

  // 2. Mandatory Site Condition Elements
  if (!s.wall_material) {
    missingFields.push('wall_material');
    errors.wall_material = 'Vật liệu kết cấu tường hai bên bắt buộc phải được chọn.';
  }

  if (!s.floor_material) {
    missingFields.push('floor_material');
    errors.floor_material = 'Vật liệu bề mặt sàn đáy bắt buộc phải được chọn.';
  }

  if (!s.floor_evenness) {
    missingFields.push('floor_evenness');
    errors.floor_evenness = 'Độ phẳng của sàn đáy bắt buộc phải được đánh giá.';
  }

  // 3. Mandatory Field Evidence Photos (At least 3 canonical slots)
  const hasOverview = !!p['OVERVIEW']?.objectPath;
  const hasBottomLeft = !!p['BOTTOM_LEFT']?.objectPath;
  const hasBottomRight = !!p['BOTTOM_RIGHT']?.objectPath;

  if (!hasOverview) {
    missingFields.push('photos.OVERVIEW');
    errors['photos.OVERVIEW'] = 'Thiếu ảnh toàn cảnh vị trí lắp đặt (OVERVIEW).';
  }

  if (!hasBottomLeft) {
    missingFields.push('photos.BOTTOM_LEFT');
    errors['photos.BOTTOM_LEFT'] = 'Thiếu ảnh cận cảnh chân tường & sàn góc trái (BOTTOM_LEFT).';
  }

  if (!hasBottomRight) {
    missingFields.push('photos.BOTTOM_RIGHT');
    errors['photos.BOTTOM_RIGHT'] = 'Thiếu ảnh cận cảnh chân tường & sàn góc phải (BOTTOM_RIGHT).';
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
    errors,
  };
}

export interface CompleteSurveyResult {
  success: boolean;
  surveyId?: string;
  message?: string;
  missingFields?: string[];
  errors?: Record<string, string>;
}

/**
 * Service: Finalize Survey & Register Formal Record in Supabase
 * - Validates input against validation gate
 * - Inserts row into public.surveys
 * - Updates public.appointments status to 'COMPLETED'
 */
export async function completeSurvey(
  input: CompleteSurveyInput,
  completedByUserId: string,
  companyId: string
): Promise<CompleteSurveyResult> {
  // 1. Enforce Validation Gate
  const validation = validateSurveyCompletionGate(input);
  if (!validation.isValid) {
    return {
      success: false,
      message: 'Không thể hoàn tất khảo sát: Còn thiếu thông tin kỹ thuật hoặc ảnh bắt buộc.',
      missingFields: validation.missingFields,
      errors: validation.errors,
    };
  }

  const adminClient = createAdminClient();

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

  if (appointment.status === 'COMPLETED') {
    return {
      success: false,
      message: 'Lịch hẹn này đã được hoàn tất khảo sát trước đó.',
    };
  }

  // 3. Serialize photos and site condition
  const photosArray: SurveyPhotoItem[] = Object.values(input.photos).filter(
    (item): item is SurveyPhotoItem => Boolean(item && item.objectPath)
  );

  const measurementsPayload: MeasurementData = {
    clear_width_mm: Number(input.measurements.clear_width_mm),
    barrier_height_mm: Number(input.measurements.barrier_height_mm),
    anticipated_flood_height_mm: Number(input.measurements.anticipated_flood_height_mm),
    width_top_mm: input.measurements.width_top_mm
      ? Number(input.measurements.width_top_mm)
      : undefined,
    width_bottom_mm: input.measurements.width_bottom_mm
      ? Number(input.measurements.width_bottom_mm)
      : undefined,
    gate_type: (input.measurements.gate_type as GateType) || 'REMOVABLE_PANEL',
    mounting_method: (input.measurements.mounting_method as MountingMethod) || 'INSIDE_JAMB',
  };

  // Structured readable text string for public.surveys.site_condition (text NOT NULL column)
  const siteConditionText = JSON.stringify({
    wall_material: input.siteCondition.wall_material,
    floor_material: input.siteCondition.floor_material,
    floor_evenness: input.siteCondition.floor_evenness,
    slope_grade: input.siteCondition.slope_grade || 'SLOPING_OUT',
    notes: input.siteCondition.notes || '',
  });

  const notes = input.notes || input.siteCondition.notes || null;
  const completedAt = new Date().toISOString();

  // 4. Insert Survey Record into Supabase
  const { data: insertedSurvey, error: insertError } = await adminClient
    .from('surveys')
    .insert({
      company_id: companyId,
      customer_id: appointment.customer_id,
      appointment_id: appointment.id,
      completed_by: completedByUserId,
      measurements: measurementsPayload,
      photos: photosArray,
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

  // 5. Update Appointment status to 'COMPLETED'
  const { error: updateAptError } = await adminClient
    .from('appointments')
    .update({
      status: 'COMPLETED',
      updated_at: completedAt,
    })
    .eq('id', appointment.id);

  if (updateAptError) {
    console.error('Warning: Survey saved but failed to update appointment status:', updateAptError);
  }

  return {
    success: true,
    surveyId: insertedSurvey.id,
    message: 'Khảo sát đã được hoàn tất và chuyển giao dữ liệu kỹ thuật thành công.',
  };
}

/**
 * Maps and standardizes a raw SurveyRecord into the formal SurveyPricingData
 * contract required by Member 7 (TV7: Pricing Engine).
 */
export function formatSurveyForPricing(survey: SurveyRecord): SurveyPricingData {
  const m = survey.measurements;

  // Safely parse site condition text (JSON string or text fallback)
  let parsedSiteCondition: SiteConditionData;
  try {
    const parsed = JSON.parse(survey.site_condition);
    parsedSiteCondition = {
      wall_material: (parsed.wall_material as WallMaterial) || 'SOLID_BRICK',
      floor_material: (parsed.floor_material as FloorMaterial) || 'CONCRETE_SMOOTH',
      floor_evenness: (parsed.floor_evenness as FloorEvenness) || 'FLAT',
      slope_grade: (parsed.slope_grade as SlopeGrade) || 'SLOPING_OUT',
      notes: parsed.notes || survey.notes || '',
    };
  } catch {
    parsedSiteCondition = {
      wall_material: 'SOLID_BRICK',
      floor_material: 'CONCRETE_SMOOTH',
      floor_evenness: 'FLAT',
      slope_grade: 'SLOPING_OUT',
      notes: survey.site_condition || survey.notes || '',
    };
  }

  const photosArray = Array.isArray(survey.photos) ? survey.photos : [];
  const overviewPhoto = photosArray.find((p) => p.slot === 'OVERVIEW');
  const bottomLeftPhoto = photosArray.find((p) => p.slot === 'BOTTOM_LEFT');
  const bottomRightPhoto = photosArray.find((p) => p.slot === 'BOTTOM_RIGHT');

  const isPricingReady =
    Boolean(m.clear_width_mm && m.clear_width_mm > 0) &&
    Boolean(m.barrier_height_mm && m.barrier_height_mm > 0) &&
    Boolean(m.anticipated_flood_height_mm !== undefined && m.anticipated_flood_height_mm > 0) &&
    Boolean(overviewPhoto?.objectPath) &&
    Boolean(bottomLeftPhoto?.objectPath) &&
    Boolean(bottomRightPhoto?.objectPath);

  return {
    surveyId: survey.id,
    appointmentId: survey.appointment_id,
    customerId: survey.customer_id,
    companyId: survey.company_id,
    completedAt: survey.completed_at,
    completedBy: survey.completed_by,
    dimensions: {
      clearWidthMm: m.clear_width_mm,
      barrierHeightMm: m.barrier_height_mm,
      anticipatedFloodHeightMm: m.anticipated_flood_height_mm,
      widthTopMm: m.width_top_mm,
      widthBottomMm: m.width_bottom_mm,
      gateType: m.gate_type || 'REMOVABLE_PANEL',
      mountingMethod: m.mounting_method || 'INSIDE_JAMB',
    },
    siteCondition: parsedSiteCondition,
    photos: {
      overviewUrl: overviewPhoto?.signedUrl,
      bottomLeftUrl: bottomLeftPhoto?.signedUrl,
      bottomRightUrl: bottomRightPhoto?.signedUrl,
      items: photosArray,
    },
    isPricingReady,
  };
}

/**
 * Adapter / Data Contract for Member 7 (TV7: Price Calculation)
 * Allows TV7 to reliably fetch full technical measurements and site conditions
 * by surveyId or customerId for automated pricing formula computation.
 */
export async function getSurveyForPricing(
  params: {
    surveyId?: string;
    appointmentId?: string;
    customerId?: string;
    companyId: string;
  },
  clientOverride?: ReturnType<typeof createAdminClient>
): Promise<SurveyPricingData | null> {
  const adminClient = clientOverride || createAdminClient();

  let query = adminClient
    .from('surveys')
    .select('*')
    .eq('company_id', params.companyId);

  if (params.surveyId) {
    query = query.eq('id', params.surveyId);
  } else if (params.appointmentId) {
    query = query.eq('appointment_id', params.appointmentId);
  } else if (params.customerId) {
    query = query.eq('customer_id', params.customerId).order('completed_at', { ascending: false });
  } else {
    return null;
  }

  const { data: rawSurvey, error } = await query.limit(1).maybeSingle();

  if (error || !rawSurvey) {
    return null;
  }

  return formatSurveyForPricing(rawSurvey as SurveyRecord);
}

