import { z } from 'zod';
import type {
  CompleteSurveyInput,
  SurveyValidationResult,
} from '../types/survey';

/**
 * Technical Enums for Survey
 */
export const GateTypeEnum = z.enum([
  'REMOVABLE_PANEL',
  'AUTOMATIC_HYDRAULIC',
  'ROLL_UP_CANVAS',
  'SWING_GATE',
]);

export const MountingMethodEnum = z.enum([
  'INSIDE_JAMB',
  'OUTSIDE_FACE',
  'INSIDE_FACE',
]);

export const WallMaterialEnum = z.enum([
  'SOLID_BRICK',
  'HOLLOW_BRICK',
  'CONCRETE',
  'STEEL_FRAME',
  'ALUMINUM_GLASS',
  'STONE_TILES',
]);

export const FloorMaterialEnum = z.enum([
  'CONCRETE_SMOOTH',
  'TILES',
  'NATURAL_STONE',
  'ROUGH_CEMENT',
  'PAVING_BRICK',
]);

export const FloorEvennessEnum = z.enum([
  'FLAT',
  'SLIGHTLY_UNEVEN',
  'HIGHLY_UNEVEN',
]);

export const SlopeGradeEnum = z.enum([
  'SLOPING_OUT',
  'LEVEL',
  'SLOPING_IN',
]);

/**
 * Geometric Measurements Zod Schema
 * Enforces:
 * - clear_width_mm / clearWidthMm: [500, 15000] mm (positive integer)
 * - barrier_height_mm / waterHeightMm: [100, 3000] mm (positive integer)
 * - anticipated_flood_height_mm: [100, 3000] mm (positive integer)
 * - step_height_mm / stepHeightMm: [0, 1000] mm (non-negative number/integer)
 */
export const SurveyMeasurementSchema = z.object({
  clear_width_mm: z
    .number()
    .int('Chiều rộng lọt lòng phải là số nguyên.')
    .min(500, 'Chiều rộng lọt lòng phải từ 500 mm đến 15000 mm.')
    .max(15000, 'Chiều rộng lọt lòng không được vượt quá 15000 mm.'),

  barrier_height_mm: z
    .number()
    .int('Chiều cao tấm chắn đề xuất phải là số nguyên.')
    .min(100, 'Chiều cao tấm chắn đề xuất phải từ 100 mm đến 3000 mm.')
    .max(3000, 'Chiều cao tấm chắn đề xuất không được vượt quá 3000 mm.'),

  anticipated_flood_height_mm: z
    .number()
    .int('Cao độ đỉnh ngập dự kiến phải là số nguyên.')
    .min(100, 'Cao độ đỉnh ngập dự kiến phải từ 100 mm đến 3000 mm.')
    .max(3000, 'Cao độ đỉnh ngập dự kiến không được vượt quá 3000 mm.'),

  step_height_mm: z
    .number()
    .min(0, 'Chiều cao bậc tam cấp (stepHeightMm) phải từ 0 mm trở lên.')
    .max(1000, 'Chiều cao bậc tam cấp (stepHeightMm) không được vượt quá 1000 mm.')
    .optional(),

  width_top_mm: z.number().int().min(500).max(15000).optional(),
  width_bottom_mm: z.number().int().min(500).max(15000).optional(),
  gate_type: GateTypeEnum,
  mounting_method: MountingMethodEnum,
});

/**
 * Site Condition Zod Schema
 */
export const SurveySiteConditionSchema = z.object({
  wall_material: WallMaterialEnum,
  floor_material: FloorMaterialEnum,
  floor_evenness: FloorEvennessEnum,
  slope_grade: SlopeGradeEnum,
  notes: z
    .string()
    .max(1000, 'Ghi chú kỹ thuật không được vượt quá 1000 ký tự.')
    .optional(),
  specialRequirements: z
    .string()
    .max(1000, 'Yêu cầu đặc biệt không được vượt quá 1000 ký tự.')
    .optional(),
});

/**
 * Photo item validation schema
 */
export const SurveyPhotoItemSchema = z.object({
  slot: z.string().min(1, 'Mã vị trí ảnh (slot) không được rỗng.'),
  signedUrl: z.string().optional(),
  uploadedAt: z.string().optional(),
  slotLabel: z.string().optional(),
  isMandatory: z.boolean().optional(),
});

/**
 * Main Runtime Validator for Survey Completion
 * Strictly validates:
 * 1. Dimensions:
 *    - clearWidthMm / clear_width_mm: integer in [500, 15000] mm
 *    - waterHeightMm / barrier_height_mm: integer in [100, 3000] mm
 *    - anticipated_flood_height_mm: integer in [100, 3000] mm
 *    - stepHeightMm / step_height_mm: number in [0, 1000] mm
 * 2. Enums:
 *    - gateType / gate_type, mountingMethod / mounting_method
 *    - wallMaterial / wall_material, floorMaterial / floor_material, floorEvenness / floor_evenness, slopeGrade / slope_grade
 * 3. Mandatory photos are checked independently in server Storage and the atomic RPC.
 * 4. Text Sanitization & Limits:
 *    - notes, specialRequirements: max length 1000 chars
 */
export function validateSurveyInput(input: CompleteSurveyInput): SurveyValidationResult {
  const missingFields: string[] = [];
  const errors: Record<string, string> = {};

  const mRaw = (input.measurements || {}) as Record<string, unknown>;
  const sRaw = (input.siteCondition || {}) as Record<string, unknown>;

  // 1. Validate clear_width_mm (or clearWidthMm)
  const rawClear =
    mRaw.clear_width_mm !== undefined
      ? mRaw.clear_width_mm
      : mRaw.clearWidthMm !== undefined
      ? mRaw.clearWidthMm
      : undefined;

  if (rawClear === undefined || rawClear === null || rawClear === '') {
    missingFields.push('clear_width_mm');
    missingFields.push('clearWidthMm');
    errors.clear_width_mm = 'Chiều rộng lọt lòng (clear_width_mm) bắt buộc phải lớn hơn 0 mm.';
    errors.clearWidthMm = errors.clear_width_mm;
  } else {
    const numClear = Number(rawClear);
    if (typeof rawClear !== 'number' || !Number.isFinite(numClear) || numClear <= 0) {
      missingFields.push('clear_width_mm');
      missingFields.push('clearWidthMm');
      errors.clear_width_mm = 'Chiều rộng lọt lòng bắt buộc là số nguyên dương.';
      errors.clearWidthMm = errors.clear_width_mm;
    } else if (!Number.isInteger(numClear)) {
      missingFields.push('clear_width_mm');
      missingFields.push('clearWidthMm');
      errors.clear_width_mm = 'Chiều rộng lọt lòng phải là số nguyên.';
      errors.clearWidthMm = errors.clear_width_mm;
    } else if (numClear < 500 || numClear > 15000) {
      missingFields.push('clear_width_mm');
      missingFields.push('clearWidthMm');
      errors.clear_width_mm = 'Chiều rộng lọt lòng phải trong khoảng hợp lý từ 500 mm đến 15000 mm.';
      errors.clearWidthMm = errors.clear_width_mm;
    }
  }

  // 2. Validate barrier_height_mm (or waterHeightMm / barrierHeightMm)
  const rawBarrier =
    mRaw.barrier_height_mm !== undefined
      ? mRaw.barrier_height_mm
      : mRaw.waterHeightMm !== undefined
      ? mRaw.waterHeightMm
      : mRaw.barrierHeightMm !== undefined
      ? mRaw.barrierHeightMm
      : undefined;

  if (rawBarrier === undefined || rawBarrier === null || rawBarrier === '') {
    missingFields.push('barrier_height_mm');
    missingFields.push('waterHeightMm');
    errors.barrier_height_mm =
      'Chiều cao tấm chắn đề xuất (barrier_height_mm) bắt buộc phải lớn hơn 0 mm.';
    errors.waterHeightMm = errors.barrier_height_mm;
  } else {
    const numBarrier = Number(rawBarrier);
    if (typeof rawBarrier !== 'number' || !Number.isFinite(numBarrier) || numBarrier <= 0) {
      missingFields.push('barrier_height_mm');
      missingFields.push('waterHeightMm');
      errors.barrier_height_mm = 'Chiều cao ngăn nước / tấm chắn bắt buộc là số nguyên dương.';
      errors.waterHeightMm = errors.barrier_height_mm;
    } else if (!Number.isInteger(numBarrier)) {
      missingFields.push('barrier_height_mm');
      missingFields.push('waterHeightMm');
      errors.barrier_height_mm = 'Chiều cao tấm chắn đề xuất phải là số nguyên.';
      errors.waterHeightMm = errors.barrier_height_mm;
    } else if (numBarrier < 100 || numBarrier > 3000) {
      missingFields.push('barrier_height_mm');
      missingFields.push('waterHeightMm');
      errors.barrier_height_mm =
        'Chiều cao ngăn nước / chắn đề xuất phải trong khoảng từ 100 mm đến 3000 mm.';
      errors.waterHeightMm = errors.barrier_height_mm;
    }
  }

  // 3. Validate anticipated_flood_height_mm
  const rawFlood =
    mRaw.anticipated_flood_height_mm !== undefined
      ? mRaw.anticipated_flood_height_mm
      : mRaw.anticipatedFloodHeightMm !== undefined
      ? mRaw.anticipatedFloodHeightMm
      : undefined;

  if (rawFlood === undefined || rawFlood === null || rawFlood === '') {
    missingFields.push('anticipated_flood_height_mm');
    errors.anticipated_flood_height_mm =
      'Cao độ đỉnh ngập dự kiến (anticipated_flood_height_mm) bắt buộc phải lớn hơn 0 mm.';
  } else {
    const numFlood = Number(rawFlood);
    if (typeof rawFlood !== 'number' || !Number.isFinite(numFlood) || numFlood <= 0) {
      missingFields.push('anticipated_flood_height_mm');
      errors.anticipated_flood_height_mm =
        'Cao độ đỉnh ngập dự kiến bắt buộc là số nguyên dương.';
    } else if (!Number.isInteger(numFlood)) {
      missingFields.push('anticipated_flood_height_mm');
      errors.anticipated_flood_height_mm = 'Cao độ đỉnh ngập dự kiến phải là số nguyên.';
    } else if (numFlood < 100 || numFlood > 3000) {
      missingFields.push('anticipated_flood_height_mm');
      errors.anticipated_flood_height_mm =
        'Cao độ ngập dự kiến phải trong khoảng từ 100 mm đến 3000 mm.';
    }
  }

  // 4. Validate optional step_height_mm (or stepHeightMm): [0, 1000] mm
  const rawStep =
    mRaw.step_height_mm !== undefined
      ? mRaw.step_height_mm
      : mRaw.stepHeightMm !== undefined
      ? mRaw.stepHeightMm
      : undefined;

  if (rawStep !== undefined && rawStep !== null && rawStep !== '') {
    const numStep = Number(rawStep);
    if (typeof rawStep !== 'number' || !Number.isFinite(numStep) || numStep < 0 || numStep > 1000) {
      missingFields.push('step_height_mm');
      missingFields.push('stepHeightMm');
      errors.step_height_mm =
        'Chiều cao bậc tam cấp (stepHeightMm) phải là số không âm trong khoảng từ 0 mm đến 1000 mm.';
      errors.stepHeightMm = errors.step_height_mm;
    }
  }

  // 5. Validate GateType Enum if provided
  const gateType = (mRaw.gate_type || mRaw.gateType) as string | undefined;
  if (!GateTypeEnum.safeParse(gateType).success) {
    missingFields.push('gate_type');
    missingFields.push('gateType');
    errors.gate_type = `Loại cửa chống ngập "${gateType}" không hợp lệ.`;
    errors.gateType = errors.gate_type;
  }

  // 6. Validate MountingMethod Enum if provided
  const mountingMethod = (mRaw.mounting_method || mRaw.mountingMethod) as string | undefined;
  if (!MountingMethodEnum.safeParse(mountingMethod).success) {
    missingFields.push('mounting_method');
    missingFields.push('mountingMethod');
    errors.mounting_method = `Phương án gắn ray "${mountingMethod}" không hợp lệ.`;
    errors.mountingMethod = errors.mounting_method;
  }

  // 7. Validate Wall Material Enum
  const wallMaterial = (sRaw.wall_material || sRaw.wallMaterial) as string | undefined;
  if (!wallMaterial) {
    missingFields.push('wall_material');
    missingFields.push('wallMaterial');
    errors.wall_material = 'Vật liệu kết cấu tường hai bên bắt buộc phải được chọn.';
    errors.wallMaterial = errors.wall_material;
  } else if (!WallMaterialEnum.safeParse(wallMaterial).success) {
    missingFields.push('wall_material');
    missingFields.push('wallMaterial');
    errors.wall_material = `Vật liệu tường "${wallMaterial}" không hợp lệ.`;
    errors.wallMaterial = errors.wall_material;
  }

  // 8. Validate Floor Material Enum
  const floorMaterial = (sRaw.floor_material || sRaw.floorMaterial) as string | undefined;
  if (!floorMaterial) {
    missingFields.push('floor_material');
    missingFields.push('floorMaterial');
    errors.floor_material = 'Vật liệu bề mặt sàn đáy bắt buộc phải được chọn.';
    errors.floorMaterial = errors.floor_material;
  } else if (!FloorMaterialEnum.safeParse(floorMaterial).success) {
    missingFields.push('floor_material');
    missingFields.push('floorMaterial');
    errors.floor_material = `Vật liệu sàn "${floorMaterial}" không hợp lệ.`;
    errors.floorMaterial = errors.floor_material;
  }

  // 9. Validate Floor Evenness Enum
  const floorEvenness = (sRaw.floor_evenness || sRaw.floorEvenness) as string | undefined;
  if (!floorEvenness) {
    missingFields.push('floor_evenness');
    missingFields.push('floorEvenness');
    errors.floor_evenness = 'Độ phẳng của sàn đáy bắt buộc phải được đánh giá.';
    errors.floorEvenness = errors.floor_evenness;
  } else if (!FloorEvennessEnum.safeParse(floorEvenness).success) {
    missingFields.push('floor_evenness');
    missingFields.push('floorEvenness');
    errors.floor_evenness = `Độ phẳng sàn "${floorEvenness}" không hợp lệ.`;
    errors.floorEvenness = errors.floor_evenness;
  }

  // 10. Validate Slope Grade Enum
  const slopeGrade = (sRaw.slope_grade || sRaw.slopeGrade) as string | undefined;
  if (!slopeGrade) {
    missingFields.push('slope_grade');
    missingFields.push('slopeGrade');
    errors.slope_grade = 'Hướng dốc thoát nước của mặt sàn bắt buộc phải được chọn.';
    errors.slopeGrade = errors.slope_grade;
  } else if (!SlopeGradeEnum.safeParse(slopeGrade).success) {
    missingFields.push('slope_grade');
    missingFields.push('slopeGrade');
    errors.slope_grade = `Hướng dốc sàn "${slopeGrade}" không hợp lệ.`;
    errors.slopeGrade = errors.slope_grade;
  }

  // 11. Text Length Limits (notes & specialRequirements)
  const rawNotes = (input.notes || sRaw.notes) as string | undefined;
  if (rawNotes && typeof rawNotes === 'string') {
    const trimmed = rawNotes.trim();
    if (trimmed.length > 1000) {
      missingFields.push('notes');
      errors.notes = 'Ghi chú kỹ thuật không được vượt quá 1000 ký tự.';
    }
  }

  const rawSpecial = sRaw.specialRequirements as string | undefined;
  if (rawSpecial && typeof rawSpecial === 'string') {
    const trimmed = rawSpecial.trim();
    if (trimmed.length > 1000) {
      missingFields.push('specialRequirements');
      errors.specialRequirements = 'Yêu cầu đặc biệt không được vượt quá 1000 ký tự.';
    }
  }

  for (const key of ['width_top_mm', 'width_bottom_mm'] as const) {
    if (!SurveyMeasurementSchema.shape[key].safeParse(mRaw[key]).success) {
      missingFields.push(key); errors[key] = 'Khẩu độ phải là số nguyên từ 500 đến 15000 mm.';
    }
  }

  // Evidence is verified from Storage by the server, never from a browser photo map.

  return {
    isValid: missingFields.length === 0,
    missingFields,
    errors,
  };
}

/**
 * Sanitizes input text fields (trim excess whitespace and normalize)
 */
export function sanitizeSurveyInput(input: CompleteSurveyInput): CompleteSurveyInput {
  const sanitizedNotes = typeof input.notes === 'string' ? input.notes.trim() : undefined;
  const siteNotes =
    typeof input.siteCondition?.notes === 'string'
      ? input.siteCondition.notes.trim()
      : undefined;

  const rawSpecial = (input.siteCondition as Record<string, unknown>)?.specialRequirements;
  const siteReqs = typeof rawSpecial === 'string' ? rawSpecial.trim() : undefined;

  return {
    ...input,
    notes: sanitizedNotes,
    siteCondition: {
      ...input.siteCondition,
      notes: siteNotes || sanitizedNotes,
      ...(siteReqs !== undefined ? { specialRequirements: siteReqs } : {}),
    },
  };
}
