import 'server-only';
import { SurveyMeasurementSchema, SurveySiteConditionSchema } from '../validations/survey.schema';
import { createAdminClient } from '../../../lib/supabase/admin';
import type {
  SurveyRecord,
  SurveyPricingData,
  SiteConditionData,
  WallMaterial,
  FloorMaterial,
  FloorEvenness,
  SlopeGrade,
  MeasurementData,
} from '../types/survey';

/**
 * Canonical deterministic unit conversion from millimeters (mm) to meters (m).
 * Formula: meters = mm / 1000
 * Invariant: Fails closed on invalid, NaN, or non-positive millimeter values.
 */
export function convertMillimetersToMeters(mm: unknown): number {
  const num = typeof mm === 'string' && mm.trim() !== '' ? Number(mm) : mm;
  if (typeof num !== 'number' || isNaN(num) || !isFinite(num) || num <= 0) {
    throw new Error('INVALID_UNIT_CONVERSION: Giá trị milimét phải là số dương hợp lệ.');
  }
  return Math.round(num) / 1000;
}

export interface CanonicalPricingMeasurements {
  width?: number; // width in meters (m) derived deterministically from clear_width_mm / 1000
  height?: number; // height in meters (m) derived deterministically from barrier_height_mm / 1000
  unit: 'm';
  clear_width_mm?: number;
  barrier_height_mm?: number;
  anticipated_flood_height_mm?: number;
  gate_type?: string;
  mounting_method?: string;
  survey_id?: string;
  [key: string]: unknown;
}

/**
 * ONE Canonical Survey → Pricing Adapter.
 * Bridges Survey technical millimeter measurements (clear_width_mm, barrier_height_mm)
 * to Pricing Engine meter dimensions (width, height) deterministically.
 *
 * Invariant:
 * - 2500 mm -> 2.5 m
 * - 1200 mm -> 1.2 m
 * - Deterministic, explicit units ('m').
 * - Fails closed: Never guesses or invents missing dimensions.
 * - Missing dimensions remain undefined so pricing engine marks them in missing_fields.
 */
export function adaptSurveyToPricingInput(
  survey: Partial<SurveyRecord> | { measurements?: Partial<MeasurementData>; id?: string }
): CanonicalPricingMeasurements {
  const m = survey?.measurements || ({} as Partial<MeasurementData>);
  const result: CanonicalPricingMeasurements = {
    unit: 'm',
    clear_width_mm: typeof m.clear_width_mm === 'number' && m.clear_width_mm > 0 ? m.clear_width_mm : undefined,
    barrier_height_mm: typeof m.barrier_height_mm === 'number' && m.barrier_height_mm > 0 ? m.barrier_height_mm : undefined,
    anticipated_flood_height_mm:
      typeof m.anticipated_flood_height_mm === 'number' && m.anticipated_flood_height_mm > 0
        ? m.anticipated_flood_height_mm
        : undefined,
    gate_type: m.gate_type || undefined,
    mounting_method: m.mounting_method || undefined,
    survey_id: survey?.id || undefined,
  };

  if (typeof m.clear_width_mm === 'number' && m.clear_width_mm > 0) {
    result.width = convertMillimetersToMeters(m.clear_width_mm);
  }

  if (typeof m.barrier_height_mm === 'number' && m.barrier_height_mm > 0) {
    result.height = convertMillimetersToMeters(m.barrier_height_mm);
  }

  return result;
}

/**
 * Technical Pricing Adapter (Bàn giao dữ liệu kỹ thuật cho TV7: Pricing Engine)
 *
 * CRITICAL SECURITY / BUSINESS INVARIANT:
 * - FAIL-CLOSED: Tuyệt đối KHÔNG gán bất kỳ giá trị fallback suy đoán kỹ thuật nào
 *   (ví dụ: không gán ?? 'REMOVABLE_PANEL', ?? 'INSIDE_JAMB', ?? 'SOLID_BRICK', ?? 'FLAT', ?? 'SLOPING_OUT').
 * - Nếu kỹ thuật viên chưa đo hoặc chưa nhập liệu thông số nào, trường đó PHẢI giữ nguyên undefined.
 * - Danh sách missingTechnicalFields sẽ được tổng hợp đầy đủ.
 * - Cờ isPricingReady và isReadyForPricing sẽ là FALSE khi có bất kỳ thông số kỹ thuật cốt lõi nào bị thiếu.
 */
export function formatSurveyForPricing(survey: SurveyRecord): SurveyPricingData {
  const m = survey.measurements || ({} as SurveyRecord['measurements']);

  // 1. Phân tích hiện trạng công trình (Không gán default suy đoán)
  let parsedSiteCondition: Partial<SiteConditionData> = {};

  if (typeof survey.site_condition === 'string' && survey.site_condition.trim()) {
    try {
      const parsed = JSON.parse(survey.site_condition);
      if (parsed && typeof parsed === 'object') {
        parsedSiteCondition = {
          wall_material: (parsed.wall_material as WallMaterial) || undefined,
          floor_material: (parsed.floor_material as FloorMaterial) || undefined,
          floor_evenness: (parsed.floor_evenness as FloorEvenness) || undefined,
          slope_grade: (parsed.slope_grade as SlopeGrade) || undefined,
          notes: parsed.notes || survey.notes || '',
        };
      }
    } catch {
      parsedSiteCondition = {
        notes: survey.site_condition || survey.notes || '',
      };
    }
  } else if (survey.site_condition && typeof survey.site_condition === 'object') {
    const rawObj = survey.site_condition as Record<string, unknown>;
    parsedSiteCondition = {
      wall_material: (rawObj.wall_material as WallMaterial) || undefined,
      floor_material: (rawObj.floor_material as FloorMaterial) || undefined,
      floor_evenness: (rawObj.floor_evenness as FloorEvenness) || undefined,
      slope_grade: (rawObj.slope_grade as SlopeGrade) || undefined,
      notes: (rawObj.notes as string) || survey.notes || '',
    };
  }

  // 2. Phân tích ảnh hiện trường
  const photosArray = Array.isArray(survey.photos) ? survey.photos : [];
  const overviewPhoto = photosArray.find((p) => p.slot === 'OVERVIEW');
  const bottomLeftPhoto = photosArray.find((p) => p.slot === 'BOTTOM_LEFT');
  const bottomRightPhoto = photosArray.find((p) => p.slot === 'BOTTOM_RIGHT');

  // 3. Rà soát thông số kỹ thuật cốt lõi cho TV7 (Fail-Closed: Thu thập missing fields)
  const missingTechnicalFields: string[] = [];

  if (!m.clear_width_mm || m.clear_width_mm <= 0) {
    missingTechnicalFields.push('dimensions.clearWidthMm');
  }
  if (!m.barrier_height_mm || m.barrier_height_mm <= 0) {
    missingTechnicalFields.push('dimensions.barrierHeightMm');
  }
  if (m.anticipated_flood_height_mm === undefined || m.anticipated_flood_height_mm <= 0) {
    missingTechnicalFields.push('dimensions.anticipatedFloodHeightMm');
  }
  if (!m.gate_type) {
    missingTechnicalFields.push('dimensions.gateType');
  }
  if (!m.mounting_method) {
    missingTechnicalFields.push('dimensions.mountingMethod');
  }

  if (!parsedSiteCondition.wall_material) {
    missingTechnicalFields.push('siteCondition.wall_material');
  }
  if (!parsedSiteCondition.floor_material) {
    missingTechnicalFields.push('siteCondition.floor_material');
  }
  if (!parsedSiteCondition.floor_evenness) {
    missingTechnicalFields.push('siteCondition.floor_evenness');
  }
  if (!parsedSiteCondition.slope_grade) {
    missingTechnicalFields.push('siteCondition.slope_grade');
  }

  if (!overviewPhoto?.objectPath) {
    missingTechnicalFields.push('photos.OVERVIEW');
  }
  if (!bottomLeftPhoto?.objectPath) {
    missingTechnicalFields.push('photos.BOTTOM_LEFT');
  }
  if (!bottomRightPhoto?.objectPath) {
    missingTechnicalFields.push('photos.BOTTOM_RIGHT');
  }

  const measurementCheck = SurveyMeasurementSchema.safeParse(m);
  const siteCheck = SurveySiteConditionSchema.safeParse(parsedSiteCondition);
  if (!measurementCheck.success) for (const issue of measurementCheck.error.issues) {
    const field = `measurements.${issue.path.join('.')}`;
    if (!missingTechnicalFields.includes(field)) missingTechnicalFields.push(field);
  }
  if (!siteCheck.success) for (const issue of siteCheck.error.issues) {
    const field = `siteCondition.${issue.path.join('.')}`;
    if (!missingTechnicalFields.includes(field)) missingTechnicalFields.push(field);
  }

  const isPricingReady = missingTechnicalFields.length === 0;

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
      gateType: m.gate_type || undefined,
      mountingMethod: m.mounting_method || undefined,
    },
    siteCondition: parsedSiteCondition,
    photos: {
      overviewUrl: overviewPhoto?.signedUrl,
      bottomLeftUrl: bottomLeftPhoto?.signedUrl,
      bottomRightUrl: bottomRightPhoto?.signedUrl,
      items: photosArray,
    },
    isPricingReady,
    isReadyForPricing: isPricingReady,
    missingTechnicalFields,
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
