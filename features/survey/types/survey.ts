/**
 * Technical Measurement & Site Condition Data Contracts
 * Scope: Survey measurement input form for flood barriers (Cửa chống ngập)
 */

export type GateType =
  | 'REMOVABLE_PANEL'
  | 'AUTOMATIC_HYDRAULIC'
  | 'ROLL_UP_CANVAS'
  | 'SWING_GATE';

export type MountingMethod =
  | 'INSIDE_JAMB'
  | 'OUTSIDE_FACE'
  | 'INSIDE_FACE';

export type WallMaterial =
  | 'SOLID_BRICK'
  | 'HOLLOW_BRICK'
  | 'CONCRETE'
  | 'STEEL_FRAME'
  | 'ALUMINUM_GLASS'
  | 'STONE_TILES';

export type FloorMaterial =
  | 'CONCRETE_SMOOTH'
  | 'TILES'
  | 'NATURAL_STONE'
  | 'ROUGH_CEMENT'
  | 'PAVING_BRICK';

export type FloorEvenness =
  | 'FLAT'
  | 'SLIGHTLY_UNEVEN'
  | 'HIGHLY_UNEVEN';

export type SlopeGrade =
  | 'SLOPING_OUT'
  | 'LEVEL'
  | 'SLOPING_IN';

/**
 * Mandatory photo slots required before a survey can be finalized
 */
export type MandatoryPhotoSlot = 'OVERVIEW' | 'BOTTOM_LEFT' | 'BOTTOM_RIGHT';

/**
 * Optional photo slots for additional field evidence
 */
export type OptionalPhotoSlot = 'OBSTACLE' | 'SLOPE_DETAIL' | 'ADDITIONAL';

export type SurveyPhotoSlot = MandatoryPhotoSlot | OptionalPhotoSlot;

/**
 * Metadata representation of an uploaded survey photo
 */
export interface SurveyPhotoItem {
  slot: SurveyPhotoSlot;
  objectPath: string; // The canonical object key saved in bucket 'survey-photos'
  signedUrl?: string; // Signed preview URL
  uploadedAt: string;
  slotLabel: string;
  isMandatory: boolean;
}

/**
 * Geometric & Technical Gate Measurements (Unit: millimeters)
 */
export interface MeasurementData {
  /** Chiều rộng lọt lòng / khoảng thông thủy (mm) - Bắt buộc > 0 */
  clear_width_mm: number;
  /** Chiều cao tấm chắn đề xuất (mm) - Bắt buộc > 0 */
  barrier_height_mm: number;
  /** Cao độ đỉnh ngập dự kiến / lịch sử (mm) - Bắt buộc > 0 */
  anticipated_flood_height_mm: number;
  /** Đo kiểm tra khẩu độ má tường trên đỉnh (mm) */
  width_top_mm?: number;
  /** Đo kiểm tra khẩu độ má tường dưới chân (mm) */
  width_bottom_mm?: number;
  /** Loại cửa chống ngập */
  gate_type?: GateType;
  /** Phương án gắn ray */
  mounting_method?: MountingMethod;
}

/**
 * Physical Site Condition at Customer Entrance
 */
export interface SiteConditionData {
  /** Vật liệu kết cấu hai bên tường bắt ray */
  wall_material: WallMaterial;
  /** Vật liệu bề mặt sàn đáy tiếp xúc */
  floor_material: FloorMaterial;
  /** Độ phẳng mặt sàn đáy */
  floor_evenness: FloorEvenness;
  /** Hướng dốc thoát nước của mặt sàn */
  slope_grade: SlopeGrade;
  /** Ghi chú kỹ thuật bổ sung */
  notes?: string;
}

/**
 * Offline-ready draft stored in device localStorage
 */
export interface SurveyDraft {
  appointmentId: string;
  measurements: Partial<MeasurementData>;
  siteCondition: Partial<SiteConditionData>;
  photos?: Record<string, SurveyPhotoItem>;
  updatedAt: string;
}

/**
 * Canonical record stored in Supabase 'surveys' table
 */
export interface SurveyRecord {
  id: string;
  company_id: string;
  customer_id: string;
  appointment_id: string;
  completed_by: string;
  measurements: MeasurementData;
  photos: SurveyPhotoItem[];
  site_condition: string;
  notes?: string | null;
  completed_at: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Formal Validation Gate result before completing a survey
 */
export interface SurveyValidationResult {
  isValid: boolean;
  missingFields: string[];
  errors: Record<string, string>;
}

/**
 * Payload submitted by technician to finalize survey
 */
export interface CompleteSurveyInput {
  appointmentId: string;
  measurements: Partial<MeasurementData>;
  siteCondition: Partial<SiteConditionData>;
  photos: Record<string, SurveyPhotoItem>;
  notes?: string;
}

/**
 * Data Contract / Adapter exported for Member 7 (TV7: Price Calculation)
 * Contains all standardized technical measurements and site conditions required
 * to apply pricing matrix without hitting NEED_INFO status.
 */
export interface SurveyPricingData {
  surveyId: string;
  appointmentId: string;
  customerId: string;
  companyId: string;
  completedAt: string;
  completedBy: string;
  /** Kích thước kỹ thuật thông thủy và phương án thi công */
  dimensions: {
    clearWidthMm: number;
    barrierHeightMm: number;
    anticipatedFloodHeightMm: number;
    widthTopMm?: number;
    widthBottomMm?: number;
    gateType: GateType;
    mountingMethod: MountingMethod;
  };
  /** Kết cấu nền tường hiện trạng */
  siteCondition: SiteConditionData;
  /** Bằng chứng ảnh chụp hiện trường */
  photos: {
    overviewUrl?: string;
    bottomLeftUrl?: string;
    bottomRightUrl?: string;
    items: SurveyPhotoItem[];
  };
  /** Cờ sẵn sàng áp biểu giá */
  isPricingReady: boolean;
}
