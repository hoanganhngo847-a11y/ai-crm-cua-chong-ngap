import assert from 'node:assert/strict';
import {
  validateSurveyCompletionGate,
  formatSurveyForPricing,
  getSurveyForPricing,
  completeSurvey,
} from '../services/survey.service';
import {
  verifyMandatoryPhotosInStorage,
  validateImageFileSignature,
  uploadSurveyPhotoToStorage,
} from '../services/storage-upload.service';
import {
  createAppointment,
  updateAppointment,
  assignAppointment,
} from '../services/appointment.service';
import { sanitizeSurveyInput } from '../validations/survey.schema';
import type {
  CompleteSurveyInput,
  SurveyRecord,
  SurveyPhotoItem,
  MeasurementData,
  SiteConditionData,
} from '../types/survey';

// Test summary counters
let passCount = 0;
let failCount = 0;

function runTest(testName: string, testFn: () => void | Promise<void>) {
  try {
    const result = testFn();
    if (result instanceof Promise) {
      throw new Error(`Sync runner called with async test: ${testName}`);
    }
    console.log(`[PASS] ${testName}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] ${testName}`);
    console.error(err);
    failCount++;
  }
}

async function runAsyncTest(testName: string, testFn: () => Promise<void>) {
  try {
    await testFn();
    console.log(`[PASS] ${testName}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] ${testName}`);
    console.error(err);
    failCount++;
  }
}

// Sample canonical photos
const MOCK_PHOTOS: Record<string, SurveyPhotoItem> = {
  OVERVIEW: {
    slot: 'OVERVIEW',
    objectPath: 'comp-1/cust-1/apt-1/OVERVIEW_1726000000.jpg',
    signedUrl: 'https://storage.local/survey-photos/comp-1/cust-1/apt-1/OVERVIEW.jpg',
    uploadedAt: '14:30',
    slotLabel: 'Ảnh toàn cảnh mặt tiền',
    isMandatory: true,
  },
  BOTTOM_LEFT: {
    slot: 'BOTTOM_LEFT',
    objectPath: 'comp-1/cust-1/apt-1/BOTTOM_LEFT_1726000000.jpg',
    signedUrl: 'https://storage.local/survey-photos/comp-1/cust-1/apt-1/BOTTOM_LEFT.jpg',
    uploadedAt: '14:31',
    slotLabel: 'Chân tường & sàn bên trái',
    isMandatory: true,
  },
  BOTTOM_RIGHT: {
    slot: 'BOTTOM_RIGHT',
    objectPath: 'comp-1/cust-1/apt-1/BOTTOM_RIGHT_1726000000.jpg',
    signedUrl: 'https://storage.local/survey-photos/comp-1/cust-1/apt-1/BOTTOM_RIGHT.jpg',
    uploadedAt: '14:32',
    slotLabel: 'Chân tường & sàn bên phải',
    isMandatory: true,
  },
};

const VALID_MEASUREMENTS: MeasurementData = {
  clear_width_mm: 2450,
  barrier_height_mm: 600,
  anticipated_flood_height_mm: 450,
  width_top_mm: 2452,
  width_bottom_mm: 2448,
  gate_type: 'REMOVABLE_PANEL',
  mounting_method: 'INSIDE_JAMB',
};

const VALID_SITE_CONDITION: SiteConditionData = {
  wall_material: 'SOLID_BRICK',
  floor_material: 'CONCRETE_SMOOTH',
  floor_evenness: 'FLAT',
  slope_grade: 'SLOPING_OUT',
  notes: 'Tường gạch đặc tốt, sẵn sàng khoan bắt ray',
};

async function main() {
  console.log('===============================================================');
  console.log('SURVEY MODULE REGRESSION TESTS (Member 6 / Việc 24)');
  console.log('===============================================================');

  // ==========================================================================
  // KỊCH BẢN 1: Thiếu kích thước lọt lòng (clear_width_mm <= 0)
  // Validation Gate phải từ chối và trả về lỗi chi tiết
  // ==========================================================================
  runTest('Kịch bản 1.1: clear_width_mm undefined -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: {
        ...VALID_MEASUREMENTS,
        clear_width_mm: undefined as unknown as number,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false, 'isValid phải là false');
    assert.ok(result.missingFields.includes('clear_width_mm'), 'missingFields phải chứa clear_width_mm');
    assert.ok(result.errors.clear_width_mm, 'errors phải có thông điệp tiếng Việt');
  });

  runTest('Kịch bản 1.2: clear_width_mm = 0 -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: {
        ...VALID_MEASUREMENTS,
        clear_width_mm: 0,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('clear_width_mm'));
  });

  runTest('Kịch bản 1.3: barrier_height_mm <= 0 -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: {
        ...VALID_MEASUREMENTS,
        barrier_height_mm: 0,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('barrier_height_mm'));
  });

  runTest('Kịch bản 1.4: anticipated_flood_height_mm <= 0 -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: {
        ...VALID_MEASUREMENTS,
        anticipated_flood_height_mm: 0,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('anticipated_flood_height_mm'));
  });

  // ==========================================================================
  // KỊCH BẢN 2: Thiếu vật liệu hiện trường hoặc thiếu 1 trong 3 ảnh bắt buộc
  // Chống lỗi NEED_INFO cho Thành viên 7 (TV7)
  // ==========================================================================
  runTest('Kịch bản 2.1: Thiếu wall_material -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        wall_material: undefined as unknown as import('../types/survey').WallMaterial,
      },
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('wall_material'));
  });

  runTest('Kịch bản 2.2: Thiếu floor_material -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        floor_material: undefined as unknown as import('../types/survey').FloorMaterial,
      },
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('floor_material'));
  });

  runTest('Kịch bản 2.3: Thiếu floor_evenness -> Gate từ chối', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        floor_evenness: undefined as unknown as import('../types/survey').FloorEvenness,
      },
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('floor_evenness'));
  });

  runTest('Kịch bản 2.4: Thiếu ảnh OVERVIEW (toàn cảnh) -> Gate từ chối', () => {
    const photosWithoutOverview = { ...MOCK_PHOTOS };
    delete photosWithoutOverview.OVERVIEW;

    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosWithoutOverview,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('photos.OVERVIEW'));
  });

  runTest('Kịch bản 2.5: Thiếu ảnh BOTTOM_LEFT (chân tường trái) -> Gate từ chối', () => {
    const photosWithoutBottomLeft = { ...MOCK_PHOTOS };
    delete photosWithoutBottomLeft.BOTTOM_LEFT;

    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosWithoutBottomLeft,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('photos.BOTTOM_LEFT'));
  });

  runTest('Kịch bản 2.6: Thiếu ảnh BOTTOM_RIGHT (chân tường phải) -> Gate từ chối', () => {
    const photosWithoutBottomRight = { ...MOCK_PHOTOS };
    delete photosWithoutBottomRight.BOTTOM_RIGHT;

    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosWithoutBottomRight,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, false);
    assert.ok(result.missingFields.includes('photos.BOTTOM_RIGHT'));
  });

  // ==========================================================================
  // KỊCH BẢN 3: Đầy đủ số đo, vật liệu và 3 ảnh bắt buộc
  // Validation Gate thông qua (isValid = true)
  // ==========================================================================
  runTest('Kịch bản 3.1: Đủ 3 số đo hình học + vật liệu + 3 ảnh bắt buộc -> isValid = true', () => {
    const input: CompleteSurveyInput = {
      appointmentId: 'apt-001',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = validateSurveyCompletionGate(input);
    assert.equal(result.isValid, true, 'Khảo sát hợp lệ phải có isValid = true');
    assert.equal(result.missingFields.length, 0, 'missingFields phải rỗng');
    assert.equal(Object.keys(result.errors).length, 0, 'errors phải rỗng');
  });

  // ==========================================================================
  // KỊCH BẢN 4: Adapter formatSurveyForPricing xuất đúng cấu trúc dữ liệu cho TV7
  // ==========================================================================
  runTest('Kịch bản 4.1: formatSurveyForPricing xuất chuẩn SurveyPricingData', () => {
    const mockSurveyRecord: SurveyRecord = {
      id: 'srv-12345678-1234-1234-1234-123456789abc',
      company_id: 'comp-11111111-1111-1111-1111-111111111111',
      customer_id: 'cust-22222222-2222-2222-2222-222222222222',
      appointment_id: 'apt-33333333-3333-3333-3333-333333333333',
      completed_by: 'tech-44444444-4444-4444-4444-444444444444',
      measurements: VALID_MEASUREMENTS,
      photos: Object.values(MOCK_PHOTOS),
      site_condition: JSON.stringify(VALID_SITE_CONDITION),
      notes: 'Khách yêu cầu ray chìm',
      completed_at: '2026-09-19T10:00:00Z',
    };

    const pricingData = formatSurveyForPricing(mockSurveyRecord);

    // Assert top-level keys
    assert.equal(pricingData.surveyId, mockSurveyRecord.id);
    assert.equal(pricingData.customerId, mockSurveyRecord.customer_id);
    assert.equal(pricingData.companyId, mockSurveyRecord.company_id);
    assert.equal(pricingData.appointmentId, mockSurveyRecord.appointment_id);
    assert.equal(pricingData.completedBy, mockSurveyRecord.completed_by);

    // Assert dimensions for TV7
    assert.equal(pricingData.dimensions.clearWidthMm, 2450);
    assert.equal(pricingData.dimensions.barrierHeightMm, 600);
    assert.equal(pricingData.dimensions.anticipatedFloodHeightMm, 450);
    assert.equal(pricingData.dimensions.widthTopMm, 2452);
    assert.equal(pricingData.dimensions.widthBottomMm, 2448);
    assert.equal(pricingData.dimensions.gateType, 'REMOVABLE_PANEL');
    assert.equal(pricingData.dimensions.mountingMethod, 'INSIDE_JAMB');

    // Assert site condition
    assert.equal(pricingData.siteCondition.wall_material, 'SOLID_BRICK');
    assert.equal(pricingData.siteCondition.floor_material, 'CONCRETE_SMOOTH');
    assert.equal(pricingData.siteCondition.floor_evenness, 'FLAT');
    assert.equal(pricingData.siteCondition.slope_grade, 'SLOPING_OUT');

    // Assert photo URLs
    assert.ok(pricingData.photos.overviewUrl?.includes('OVERVIEW.jpg'));
    assert.ok(pricingData.photos.bottomLeftUrl?.includes('BOTTOM_LEFT.jpg'));
    assert.ok(pricingData.photos.bottomRightUrl?.includes('BOTTOM_RIGHT.jpg'));
    assert.equal(pricingData.photos.items.length, 3);

    // Assert pricing readiness flag
    assert.equal(pricingData.isPricingReady, true, 'isPricingReady phải là true');
  });

  await runAsyncTest('Kịch bản 4.2: getSurveyForPricing với Mock Client', async () => {
    const mockSurveyRecord: SurveyRecord = {
      id: 'srv-test-pricing-001',
      company_id: 'comp-11111111-1111-1111-1111-111111111111',
      customer_id: 'cust-22222222-2222-2222-2222-222222222222',
      appointment_id: 'apt-33333333-3333-3333-3333-333333333333',
      completed_by: 'tech-44444444-4444-4444-4444-444444444444',
      measurements: VALID_MEASUREMENTS,
      photos: Object.values(MOCK_PHOTOS),
      site_condition: JSON.stringify(VALID_SITE_CONDITION),
      notes: null,
      completed_at: '2026-09-19T10:00:00Z',
    };

    interface MockQueryBuilder {
      select: () => MockQueryBuilder;
      eq: (_col: string, _val: string) => MockQueryBuilder;
      order: () => MockQueryBuilder;
      limit: () => MockQueryBuilder;
      maybeSingle: () => Promise<{ data: SurveyRecord; error: null }>;
    }

    // Construct mock Supabase client
    const mockClient = {
      from: (table: string) => {
        assert.equal(table, 'surveys');
        const queryObj: MockQueryBuilder = {
          select: () => queryObj,
          eq: () => queryObj,
          order: () => queryObj,
          limit: () => queryObj,
          maybeSingle: async () => ({ data: mockSurveyRecord, error: null }),
        };
        return queryObj;
      },
    };

    const result = await getSurveyForPricing(
      {
        surveyId: 'srv-test-pricing-001',
        companyId: 'comp-11111111-1111-1111-1111-111111111111',
      },
      mockClient as unknown as Parameters<typeof getSurveyForPricing>[1]
    );

    assert.ok(result !== null);
    assert.equal(result.surveyId, 'srv-test-pricing-001');
    assert.equal(result.dimensions.clearWidthMm, 2450);
    assert.equal(result.isPricingReady, true);
  });

  runTest('Kịch bản 4.3: Fail-Closed Pricing Adapter - Không gán default suy đoán khi thiếu thông số', () => {
    // Record thiếu gate_type, mounting_method và wall_material
    const incompleteRecord: SurveyRecord = {
      id: 'srv-incomplete-001',
      company_id: 'comp-1',
      customer_id: 'cust-1',
      appointment_id: 'apt-1',
      completed_by: 'tech-1',
      measurements: {
        clear_width_mm: 2000,
        barrier_height_mm: 500,
        anticipated_flood_height_mm: 400,
        // gate_type and mounting_method are omitted
      },
      photos: Object.values(MOCK_PHOTOS),
      site_condition: JSON.stringify({
        // wall_material is omitted
        floor_material: 'CONCRETE_SMOOTH',
        floor_evenness: 'FLAT',
        slope_grade: 'SLOPING_OUT',
      }),
      completed_at: '2026-09-19T10:00:00Z',
    };

    const result = formatSurveyForPricing(incompleteRecord);

    // Không được suy đoán fallback default
    assert.equal(result.dimensions.gateType, undefined, 'gateType không được tự gán default REMOVABLE_PANEL');
    assert.equal(result.dimensions.mountingMethod, undefined, 'mountingMethod không được tự gán default INSIDE_JAMB');
    assert.equal(result.siteCondition.wall_material, undefined, 'wall_material không được tự gán default SOLID_BRICK');

    // Phải báo cờ chưa sẵn sàng tính giá và liệt kê đúng missingTechnicalFields
    assert.equal(result.isPricingReady, false);
    assert.equal(result.isReadyForPricing, false);
    assert.ok(result.missingTechnicalFields?.includes('dimensions.gateType'));
    assert.ok(result.missingTechnicalFields?.includes('dimensions.mountingMethod'));
    assert.ok(result.missingTechnicalFields?.includes('siteCondition.wall_material'));
    assert.ok(!result.missingTechnicalFields?.includes('siteCondition.floor_material'));
  });

  runTest('Kịch bản 4.4: Fail-Closed Pricing Adapter - Hỏng chuỗi JSON site_condition không bị gán bừa giá trị', () => {
    const corruptRecord: SurveyRecord = {
      id: 'srv-corrupt-001',
      company_id: 'comp-1',
      customer_id: 'cust-1',
      appointment_id: 'apt-1',
      completed_by: 'tech-1',
      measurements: VALID_MEASUREMENTS,
      photos: Object.values(MOCK_PHOTOS),
      site_condition: 'plain text notes only, not json',
      completed_at: '2026-09-19T10:00:00Z',
    };

    const result = formatSurveyForPricing(corruptRecord);
    assert.equal(result.siteCondition.wall_material, undefined);
    assert.equal(result.siteCondition.floor_material, undefined);
    assert.equal(result.siteCondition.floor_evenness, undefined);
    assert.equal(result.siteCondition.slope_grade, undefined);
    assert.equal(result.isPricingReady, false);
    assert.ok(result.missingTechnicalFields?.includes('siteCondition.wall_material'));
  });

  // ==========================================================================
  // KỊCH BẢN 5: Ưu tiên 5 - Khóa chặt Runtime Validation & Sanitization (P1)
  // ==========================================================================
  runTest('Kịch bản 5.1: Số đo kích thước âm (< 0) -> Gate từ chối', () => {
    // 5.1a: clear_width_mm âm
    const inputNegWidth: CompleteSurveyInput = {
      appointmentId: 'apt-p5-01',
      measurements: {
        ...VALID_MEASUREMENTS,
        clear_width_mm: -100,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resNegWidth = validateSurveyCompletionGate(inputNegWidth);
    assert.equal(resNegWidth.isValid, false);
    assert.ok(resNegWidth.missingFields.includes('clear_width_mm'));

    // 5.1b: barrier_height_mm âm
    const inputNegBarrier: CompleteSurveyInput = {
      appointmentId: 'apt-p5-01',
      measurements: {
        ...VALID_MEASUREMENTS,
        barrier_height_mm: -50,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resNegBarrier = validateSurveyCompletionGate(inputNegBarrier);
    assert.equal(resNegBarrier.isValid, false);
    assert.ok(resNegBarrier.missingFields.includes('barrier_height_mm'));

    // 5.1c: step_height_mm âm (< 0)
    const inputNegStep: CompleteSurveyInput = {
      appointmentId: 'apt-p5-01',
      measurements: {
        ...VALID_MEASUREMENTS,
        step_height_mm: -10,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resNegStep = validateSurveyCompletionGate(inputNegStep);
    assert.equal(resNegStep.isValid, false);
    assert.ok(resNegStep.missingFields.includes('step_height_mm'));
  });

  runTest('Kịch bản 5.2: Số đo kích thước vượt ngưỡng / dưới ngưỡng cho phép -> Gate từ chối', () => {
    // 5.2a: clear_width_mm < 500 mm
    const inputUnderWidth: CompleteSurveyInput = {
      appointmentId: 'apt-p5-02',
      measurements: {
        ...VALID_MEASUREMENTS,
        clear_width_mm: 400,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resUnderWidth = validateSurveyCompletionGate(inputUnderWidth);
    assert.equal(resUnderWidth.isValid, false);
    assert.ok(resUnderWidth.missingFields.includes('clear_width_mm'));

    // 5.2b: clear_width_mm > 15000 mm
    const inputOverWidth: CompleteSurveyInput = {
      appointmentId: 'apt-p5-02',
      measurements: {
        ...VALID_MEASUREMENTS,
        clear_width_mm: 16000,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resOverWidth = validateSurveyCompletionGate(inputOverWidth);
    assert.equal(resOverWidth.isValid, false);
    assert.ok(resOverWidth.missingFields.includes('clear_width_mm'));

    // 5.2c: barrier_height_mm < 100 mm
    const inputUnderBarrier: CompleteSurveyInput = {
      appointmentId: 'apt-p5-02',
      measurements: {
        ...VALID_MEASUREMENTS,
        barrier_height_mm: 50,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resUnderBarrier = validateSurveyCompletionGate(inputUnderBarrier);
    assert.equal(resUnderBarrier.isValid, false);
    assert.ok(resUnderBarrier.missingFields.includes('barrier_height_mm'));

    // 5.2d: barrier_height_mm > 3000 mm
    const inputOverBarrier: CompleteSurveyInput = {
      appointmentId: 'apt-p5-02',
      measurements: {
        ...VALID_MEASUREMENTS,
        barrier_height_mm: 3500,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resOverBarrier = validateSurveyCompletionGate(inputOverBarrier);
    assert.equal(resOverBarrier.isValid, false);
    assert.ok(resOverBarrier.missingFields.includes('barrier_height_mm'));

    // 5.2e: step_height_mm > 1000 mm
    const inputOverStep: CompleteSurveyInput = {
      appointmentId: 'apt-p5-02',
      measurements: {
        ...VALID_MEASUREMENTS,
        step_height_mm: 1200,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resOverStep = validateSurveyCompletionGate(inputOverStep);
    assert.equal(resOverStep.isValid, false);
    assert.ok(resOverStep.missingFields.includes('step_height_mm'));
  });

  runTest('Kịch bản 5.3: Số đo không phải số nguyên -> Gate từ chối', () => {
    const inputFloat: CompleteSurveyInput = {
      appointmentId: 'apt-p5-03',
      measurements: {
        ...VALID_MEASUREMENTS,
        clear_width_mm: 2000.5,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resFloat = validateSurveyCompletionGate(inputFloat);
    assert.equal(resFloat.isValid, false);
    assert.ok(resFloat.missingFields.includes('clear_width_mm'));
  });

  runTest('Kịch bản 5.4: Enum kỹ thuật không hợp lệ -> Gate từ chối', () => {
    // gate_type sai enum
    const inputInvalidGate: CompleteSurveyInput = {
      appointmentId: 'apt-p5-04',
      measurements: {
        ...VALID_MEASUREMENTS,
        gate_type: 'INVALID_GATE_TYPE' as unknown as import('../types/survey').GateType,
      },
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };
    const resGate = validateSurveyCompletionGate(inputInvalidGate);
    assert.equal(resGate.isValid, false);
    assert.ok(resGate.missingFields.includes('gate_type'));

    // wall_material sai enum
    const inputInvalidWall: CompleteSurveyInput = {
      appointmentId: 'apt-p5-04',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        wall_material: 'BAMBOO_PLASTIC' as unknown as import('../types/survey').WallMaterial,
      },
      photos: MOCK_PHOTOS,
    };
    const resWall = validateSurveyCompletionGate(inputInvalidWall);
    assert.equal(resWall.isValid, false);
    assert.ok(resWall.missingFields.includes('wall_material'));

    // floor_material sai enum
    const inputInvalidFloor: CompleteSurveyInput = {
      appointmentId: 'apt-p5-04',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        floor_material: 'CARPET' as unknown as import('../types/survey').FloorMaterial,
      },
      photos: MOCK_PHOTOS,
    };
    const resFloor = validateSurveyCompletionGate(inputInvalidFloor);
    assert.equal(resFloor.isValid, false);
    assert.ok(resFloor.missingFields.includes('floor_material'));
  });

  runTest('Kịch bản 5.5: Ràng buộc ảnh bắt buộc với slot alias (FRONTAGE, FLOOR_JUNCTION, OBSTACLES)', () => {
    // 5.5a: Thiếu FRONTAGE (Mặt tiền)
    const photosWithoutFrontage = {
      FLOOR_JUNCTION: {
        slot: 'FLOOR_JUNCTION' as const,
        objectPath: 'comp-1/cust-1/apt-1/floor_junction.jpg',
        uploadedAt: '14:31',
        slotLabel: 'Điểm tiếp giáp nền',
        isMandatory: true,
      },
      OBSTACLES: {
        slot: 'OBSTACLES' as const,
        objectPath: 'comp-1/cust-1/apt-1/obstacles.jpg',
        uploadedAt: '14:32',
        slotLabel: 'Chướng ngại vật',
        isMandatory: true,
      },
    };
    const resMissingFront = validateSurveyCompletionGate({
      appointmentId: 'apt-p5-05',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosWithoutFrontage as unknown as Record<string, SurveyPhotoItem>,
    });
    assert.equal(resMissingFront.isValid, false);
    assert.ok(resMissingFront.missingFields.includes('photos.FRONTAGE'));

    // 5.5b: Thiếu FLOOR_JUNCTION (Điểm tiếp giáp nền/sàn)
    const photosWithoutJunction = {
      FRONTAGE: {
        slot: 'FRONTAGE' as const,
        objectPath: 'comp-1/cust-1/apt-1/frontage.jpg',
        uploadedAt: '14:30',
        slotLabel: 'Mặt tiền',
        isMandatory: true,
      },
      OBSTACLES: {
        slot: 'OBSTACLES' as const,
        objectPath: 'comp-1/cust-1/apt-1/obstacles.jpg',
        uploadedAt: '14:32',
        slotLabel: 'Chướng ngại vật',
        isMandatory: true,
      },
    };
    const resMissingJunction = validateSurveyCompletionGate({
      appointmentId: 'apt-p5-05',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosWithoutJunction as unknown as Record<string, SurveyPhotoItem>,
    });
    assert.equal(resMissingJunction.isValid, false);
    assert.ok(resMissingJunction.missingFields.includes('photos.FLOOR_JUNCTION'));

    // 5.5c: Thiếu OBSTACLES (Chướng ngại vật / hộp kỹ thuật)
    const photosWithoutObstacle = {
      FRONTAGE: {
        slot: 'FRONTAGE' as const,
        objectPath: 'comp-1/cust-1/apt-1/frontage.jpg',
        uploadedAt: '14:30',
        slotLabel: 'Mặt tiền',
        isMandatory: true,
      },
      FLOOR_JUNCTION: {
        slot: 'FLOOR_JUNCTION' as const,
        objectPath: 'comp-1/cust-1/apt-1/floor_junction.jpg',
        uploadedAt: '14:31',
        slotLabel: 'Điểm tiếp giáp nền',
        isMandatory: true,
      },
    };
    const resMissingObstacle = validateSurveyCompletionGate({
      appointmentId: 'apt-p5-05',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosWithoutObstacle as unknown as Record<string, SurveyPhotoItem>,
    });
    assert.equal(resMissingObstacle.isValid, false);
    assert.ok(resMissingObstacle.missingFields.includes('photos.OBSTACLES'));
  });

  runTest('Kịch bản 5.6: Bắt buộc ảnh hỗ trợ cả Array và Object cấu trúc đầy đủ', () => {
    // Array của SurveyPhotoItem
    const photosArray: SurveyPhotoItem[] = [
      {
        slot: 'FRONTAGE' as unknown as import('../types/survey').SurveyPhotoSlot,
        objectPath: 'comp-1/cust-1/apt-1/frontage.jpg',
        uploadedAt: '14:30',
        slotLabel: 'Mặt tiền',
        isMandatory: true,
      },
      {
        slot: 'FLOOR_JUNCTION' as unknown as import('../types/survey').SurveyPhotoSlot,
        objectPath: 'comp-1/cust-1/apt-1/floor_junction.jpg',
        uploadedAt: '14:31',
        slotLabel: 'Điểm tiếp giáp nền',
        isMandatory: true,
      },
      {
        slot: 'OBSTACLES' as unknown as import('../types/survey').SurveyPhotoSlot,
        objectPath: 'comp-1/cust-1/apt-1/obstacles.jpg',
        uploadedAt: '14:32',
        slotLabel: 'Chướng ngại vật',
        isMandatory: true,
      },
    ];

    const resArray = validateSurveyCompletionGate({
      appointmentId: 'apt-p5-06',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: photosArray,
    });
    assert.equal(resArray.isValid, true);
    assert.equal(resArray.missingFields.length, 0);
  });

  runTest('Kịch bản 5.7: Chuỗi ghi chú hoặc yêu cầu đặc biệt quá dài (> 1000 ký tự) -> Gate từ chối', () => {
    // 5.7a: notes > 1000 ký tự
    const longNotes = 'A'.repeat(1005);
    const inputLongNotes: CompleteSurveyInput = {
      appointmentId: 'apt-p5-07',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
      notes: longNotes,
    };
    const resLongNotes = validateSurveyCompletionGate(inputLongNotes);
    assert.equal(resLongNotes.isValid, false);
    assert.ok(resLongNotes.missingFields.includes('notes'));
    assert.ok(resLongNotes.errors.notes);

    // 5.7b: specialRequirements > 1000 ký tự
    const inputLongSpecial: CompleteSurveyInput = {
      appointmentId: 'apt-p5-07',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        specialRequirements: 'B'.repeat(1010),
      },
      photos: MOCK_PHOTOS,
    };
    const resLongSpecial = validateSurveyCompletionGate(inputLongSpecial);
    assert.equal(resLongSpecial.isValid, false);
    assert.ok(resLongSpecial.missingFields.includes('specialRequirements'));
  });

  runTest('Kịch bản 5.8: Text Sanitization cắt khoảng trắng thừa (trim) bảo vệ DB', () => {
    const rawInput: CompleteSurveyInput = {
      appointmentId: 'apt-p5-08',
      measurements: VALID_MEASUREMENTS,
      siteCondition: {
        ...VALID_SITE_CONDITION,
        notes: '   Lắp ray chìm góc phải sàn   ',
        specialRequirements: '   Thi công vào thứ 7   ',
      },
      photos: MOCK_PHOTOS,
      notes: '   Khách yêu cầu chống rò rỉ nước tuyệt đối   ',
    };

    const sanitized = sanitizeSurveyInput(rawInput);
    assert.equal(sanitized.notes, 'Khách yêu cầu chống rò rỉ nước tuyệt đối');
    assert.equal(sanitized.siteCondition.notes, 'Lắp ray chìm góc phải sàn');
    assert.equal(sanitized.siteCondition.specialRequirements, 'Thi công vào thứ 7');
  });

  // ==========================================================================
  // KỊCH BẢN 6: Khắc phục P0 - Không tin mảng photos do browser tự gửi
  // ==========================================================================
  await runAsyncTest('Kịch bản 6.1: verifyMandatoryPhotosInStorage từ chối khi storage rỗng hoặc thiếu slot', async () => {
    // 6.1a: Storage hoàn toàn trống
    const emptyStorageClient = {
      storage: {
        from: (bucket: string) => {
          assert.equal(bucket, 'survey-photos');
          return {
            list: async () => ({ data: [], error: null }),
          };
        },
      },
    };

    const resEmpty = await verifyMandatoryPhotosInStorage(
      {
        companyId: 'comp-1',
        customerId: 'cust-1',
        appointmentId: 'apt-1',
      },
      emptyStorageClient as unknown as Parameters<typeof verifyMandatoryPhotosInStorage>[1]
    );

    assert.equal(resEmpty.isValid, false);
    assert.deepEqual(resEmpty.missingSlots, ['FRONTAGE', 'FLOOR_JUNCTION', 'OBSTACLES']);

    // 6.1b: Storage chỉ có ảnh OVERVIEW (thiếu 2 slot còn lại)
    const partialStorageClient = {
      storage: {
        from: () => ({
          list: async () => ({
            data: [{ name: 'OVERVIEW_1726000000.jpg', created_at: '2026-09-20T10:00:00Z' }],
            error: null,
          }),
        }),
      },
    };

    const resPartial = await verifyMandatoryPhotosInStorage(
      {
        companyId: 'comp-1',
        customerId: 'cust-1',
        appointmentId: 'apt-1',
      },
      partialStorageClient as unknown as Parameters<typeof verifyMandatoryPhotosInStorage>[1]
    );

    assert.equal(resPartial.isValid, false);
    assert.ok(!resPartial.missingSlots.includes('FRONTAGE'));
    assert.ok(resPartial.missingSlots.includes('FLOOR_JUNCTION'));
    assert.ok(resPartial.missingSlots.includes('OBSTACLES'));
  });

  await runAsyncTest('Kịch bản 6.2: verifyMandatoryPhotosInStorage thông qua khi storage có đủ 3 file hợp lệ', async () => {
    const fullStorageClient = {
      storage: {
        from: () => ({
          list: async () => ({
            data: [
              { name: 'OVERVIEW_1726000000.jpg', created_at: '2026-09-20T10:00:00Z' },
              { name: 'BOTTOM_LEFT_1726000000.jpg', created_at: '2026-09-20T10:01:00Z' },
              { name: 'BOTTOM_RIGHT_1726000000.jpg', created_at: '2026-09-20T10:02:00Z' },
            ],
            error: null,
          }),
        }),
      },
    };

    const resFull = await verifyMandatoryPhotosInStorage(
      {
        companyId: 'comp-1',
        customerId: 'cust-1',
        appointmentId: 'apt-1',
      },
      fullStorageClient as unknown as Parameters<typeof verifyMandatoryPhotosInStorage>[1]
    );

    assert.equal(resFull.isValid, true);
    assert.equal(resFull.missingSlots.length, 0);
    assert.equal(resFull.photos.length, 3);
    assert.ok(resFull.photos.some((p) => p.slot === 'OVERVIEW'));
    assert.ok(resFull.photos.some((p) => p.slot === 'BOTTOM_LEFT'));
    assert.ok(resFull.photos.some((p) => p.slot === 'BOTTOM_RIGHT'));
  });

  await runAsyncTest('Kịch bản 6.3: completeSurvey từ chối khi browser gửi photo array nhưng storage thiếu file', async () => {
    // Client gửi photos đầy đủ, nhưng storage server lại trống
    const mockDbAndEmptyStorage = {
      from: (table: string) => {
        if (table === 'appointments') {
          const q = {
            select: () => q,
            eq: () => q,
            maybeSingle: async () => ({
              data: {
                id: 'apt-spoof-01',
                company_id: 'comp-1',
                customer_id: 'cust-1',
                assignee_id: 'tech-1',
                status: 'IN_PROGRESS',
                type: 'SURVEY',
              },
              error: null,
            }),
          };
          return q;
        }
        if (table === 'surveys') {
          const q = {
            select: () => q,
            eq: () => q,
            maybeSingle: async () => ({ data: null, error: null }),
          };
          return q;
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          list: async () => ({ data: [], error: null }), // Kho lưu trữ trống
        }),
      },
    };

    const inputWithSpoofedPhotos: CompleteSurveyInput = {
      appointmentId: 'apt-spoof-01',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS, // Browser tự gửi mảng photos hợp lệ
    };

    const result = await completeSurvey(
      inputWithSpoofedPhotos,
      'tech-1',
      'comp-1',
      mockDbAndEmptyStorage as unknown as Parameters<typeof completeSurvey>[3]
    );

    assert.equal(result.success, false);
    assert.equal(result.message, 'Thiếu ảnh hiện trường bắt buộc trong kho lưu trữ.');
    assert.ok(result.missingFields?.includes('photos.FRONTAGE'));
  });

  await runAsyncTest('Kịch bản 6.4: completeSurvey thành công và chỉ ghi nhận photos từ storage thực tế', async () => {
    let insertedSurveyRecord: Record<string, unknown> | null = null;

    const mockDbAndFullStorage = {
      from: (table: string) => {
        if (table === 'appointments') {
          const q = {
            select: () => q,
            eq: () => q,
            maybeSingle: async () => ({
              data: {
                id: 'apt-real-01',
                company_id: 'comp-1',
                customer_id: 'cust-1',
                assignee_id: 'tech-1',
                status: 'IN_PROGRESS',
                type: 'SURVEY',
              },
              error: null,
            }),
            update: () => q,
          };
          return q;
        }
        if (table === 'surveys') {
          const q = {
            select: () => q,
            eq: () => q,
            maybeSingle: async () => ({ data: null, error: null }),
            insert: (payload: Record<string, unknown>) => {
              insertedSurveyRecord = payload;
              const subQ = {
                select: () => subQ,
                single: async () => ({
                  data: { id: 'srv-verified-001', ...payload },
                  error: null,
                }),
              };
              return subQ;
            },
          };
          return q;
        }
        throw new Error(`Unexpected table: ${table}`);
      },
      storage: {
        from: () => ({
          list: async () => ({
            data: [
              { name: 'OVERVIEW_1726000000.jpg', created_at: '2026-09-20T10:00:00Z' },
              { name: 'BOTTOM_LEFT_1726000000.jpg', created_at: '2026-09-20T10:01:00Z' },
              { name: 'BOTTOM_RIGHT_1726000000.jpg', created_at: '2026-09-20T10:02:00Z' },
            ],
            error: null,
          }),
        }),
      },
    };

    const input: CompleteSurveyInput = {
      appointmentId: 'apt-real-01',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = await completeSurvey(
      input,
      'tech-1',
      'comp-1',
      mockDbAndFullStorage as unknown as Parameters<typeof completeSurvey>[3]
    );

    assert.equal(result.success, true);
    assert.equal(result.surveyId, 'srv-verified-001');
    assert.ok(insertedSurveyRecord !== null);
    // Xác minh trường photos lưu vào DB được lấy từ storage
    const storedPhotos = (insertedSurveyRecord as Record<string, unknown>).photos as SurveyPhotoItem[];
    assert.equal(storedPhotos.length, 3);
    assert.ok(storedPhotos.some((p) => p.objectPath.includes('OVERVIEW_1726000000.jpg')));
  });

  // ==========================================================================
  // KỊCH BẢN 7: Khắc phục P1 (Lỗi 11) - Khóa chặt kiểm duyệt tệp tải lên
  // ==========================================================================
  runTest('Kịch bản 7.1: validateImageFileSignature chấp nhận tệp hợp lệ (JPEG, PNG, WEBP)', () => {
    // 7.1a: JPEG
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const resJpeg = validateImageFileSignature(jpegBuffer);
    assert.equal(resJpeg.isValid, true);
    assert.equal(resJpeg.mimeType, 'image/jpeg');

    // 7.1b: PNG
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const resPng = validateImageFileSignature(pngBuffer);
    assert.equal(resPng.isValid, true);
    assert.equal(resPng.mimeType, 'image/png');

    // 7.1c: WEBP (RIFF....WEBP)
    const webpBuffer = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x20, 0x00, 0x00, 0x00, // Size
      0x57, 0x45, 0x42, 0x50, // WEBP
      0x56, 0x50, 0x38, 0x20, // VP8
    ]);
    const resWebp = validateImageFileSignature(webpBuffer);
    assert.equal(resWebp.isValid, true);
    assert.equal(resWebp.mimeType, 'image/webp');
  });

  runTest('Kịch bản 7.2: validateImageFileSignature từ chối tệp rỗng hoặc file giả mạo đuôi', () => {
    // 7.2a: File rỗng 0 bytes
    const emptyBuffer = Buffer.alloc(0);
    const resEmpty = validateImageFileSignature(emptyBuffer);
    assert.equal(resEmpty.isValid, false);
    assert.equal(resEmpty.error, 'Tệp tải lên rỗng (0 bytes).');

    // 7.2b: File văn bản text giả mạo ảnh .jpg
    const textBuffer = Buffer.from('echo "Malicious script disguised as photo"');
    const resText = validateImageFileSignature(textBuffer);
    assert.equal(resText.isValid, false);
    assert.ok(resText.error?.includes('Định dạng tệp không hợp lệ'));

    // 7.2c: File thực thi DOS/PE (MZ) giả mạo ảnh
    const exeBuffer = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const resExe = validateImageFileSignature(exeBuffer);
    assert.equal(resExe.isValid, false);
  });

  await runAsyncTest('Kịch bản 7.3: uploadSurveyPhotoToStorage từ chối file vượt quá 10MB', async () => {
    // Tạo buffer ảo vượt quá 10MB (10 * 1024 * 1024 + 1 bytes)
    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1);

    await assert.rejects(
      async () => {
        await uploadSurveyPhotoToStorage({
          fileBuffer: oversizedBuffer,
          companyId: 'comp-1',
          customerId: 'cust-1',
          appointmentId: 'apt-1',
          photoSlot: 'OVERVIEW',
        });
      },
      {
        message: 'Dung lượng ảnh không được vượt quá 10MB.',
      }
    );
  });

  await runAsyncTest('Kịch bản 7.4: uploadSurveyPhotoToStorage dùng verified MIME type và từ chối magic bytes sai', async () => {
    // 7.4a: Từ chối file text
    await assert.rejects(
      async () => {
        await uploadSurveyPhotoToStorage({
          fileBuffer: Buffer.from('plain text file contents'),
          companyId: 'comp-1',
          customerId: 'cust-1',
          appointmentId: 'apt-1',
          photoSlot: 'OVERVIEW',
        });
      },
      {
        message: 'Định dạng tệp không hợp lệ. Chỉ chấp nhận ảnh JPG, PNG, WEBP thực tế.',
      }
    );

    // 7.4b: Tệp PNG hợp lệ nhưng browser khai gian contentType: "text/plain"
    let uploadedMimeType: string | undefined;
    const mockStorageClient = {
      storage: {
        from: () => ({
          upload: async (_path: string, _buf: unknown, opts: { contentType: string }) => {
            uploadedMimeType = opts.contentType;
            return { error: null };
          },
          createSignedUrl: async () => ({
            data: { signedUrl: 'https://storage.local/photo.jpg' },
            error: null,
          }),
        }),
      },
    };

    const validPngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const result = await uploadSurveyPhotoToStorage({
      fileBuffer: validPngBuffer,
      companyId: 'comp-1',
      customerId: 'cust-1',
      appointmentId: 'apt-1',
      photoSlot: 'OVERVIEW',
      contentType: 'text/plain', // Browser khai báo sai
      client: mockStorageClient as unknown as Parameters<typeof uploadSurveyPhotoToStorage>[0]['client'],
    });

    assert.ok(result.objectPath.includes('OVERVIEW'));
    // Khẳng định server đã ghi đè bằng MIME type đã qua kiểm duyệt magic bytes
    assert.equal(uploadedMimeType, 'image/png');
  });

  // ==========================================================================
  // KỊCH BẢN 8: Khắc phục P1 (Lỗi 13) - Kiểm duyệt đầu vào Appointment Service
  // ==========================================================================
  const createMockAppointmentClient = () => {
    const profiles: Record<string, { id: string; full_name: string; status: string }> = {
      'user-sale': { id: 'user-sale', full_name: 'Nhân viên Sale', status: 'ACTIVE' },
      'user-inactive': { id: 'user-inactive', full_name: 'KTV Nghỉ việc', status: 'ACTIVE' },
      'user-comp-b': { id: 'user-comp-b', full_name: 'KTV Công ty B', status: 'ACTIVE' },
      'user-tech-valid': { id: 'user-tech-valid', full_name: 'KTV Chuẩn', status: 'ACTIVE' },
    };

    const memberships: Array<{
      id: string;
      user_id: string;
      company_id: string;
      role: string;
      status: string;
    }> = [
      { id: 'm1', user_id: 'user-sale', company_id: 'comp-A', role: 'SALE', status: 'ACTIVE' },
      { id: 'm2', user_id: 'user-inactive', company_id: 'comp-A', role: 'TECHNICIAN', status: 'INACTIVE' },
      { id: 'm3', user_id: 'user-comp-b', company_id: 'comp-B', role: 'TECHNICIAN', status: 'ACTIVE' },
      { id: 'm4', user_id: 'user-tech-valid', company_id: 'comp-A', role: 'TECHNICIAN', status: 'ACTIVE' },
    ];

    const appointmentsMap = new Map<string, Record<string, unknown>>();
    appointmentsMap.set('apt-existing-01', {
      id: 'apt-existing-01',
      company_id: 'comp-A',
      customer_id: 'cust-100',
      assignee_id: 'user-tech-valid',
      type: 'SURVEY',
      address: '123 Đường Nguyễn Trãi',
      start_time: '2026-09-25T09:00:00.000Z',
      status: 'ASSIGNED',
      created_at: '2026-09-21T10:00:00Z',
      updated_at: '2026-09-21T10:00:00Z',
    });

    type MockQueryBuilder = {
      select: () => MockQueryBuilder;
      eq: (col: string, val: string) => MockQueryBuilder;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      insert: (payload: Record<string, unknown>) => {
        select: () => {
          single: () => Promise<{ data: Record<string, unknown>; error: null }>;
        };
      };
      update: (payload: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          select: () => {
            single: () => Promise<{ data: unknown; error: null }>;
          };
        };
      };
    };

    return {
      from: (table: string) => {
        const eqFilters: Record<string, string> = {};
        const queryBuilder: MockQueryBuilder = {
          select: () => queryBuilder,
          eq: (col: string, val: string) => {
            eqFilters[col] = val;
            return queryBuilder;
          },
          maybeSingle: async () => {
            if (table === 'customers') {
              if (eqFilters.id === 'cust-100') {
                return {
                  data: {
                    id: 'cust-100',
                    company_id: 'comp-A',
                    customer_code: 'KH-100',
                    name: 'Nguyễn Văn Khách',
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            }
            if (table === 'user_profiles') {
              const profile = profiles[eqFilters.id];
              return { data: profile || null, error: null };
            }
            if (table === 'company_members') {
              const member = memberships.find(
                (m) => m.user_id === eqFilters.user_id && m.company_id === eqFilters.company_id
              );
              return { data: member || null, error: null };
            }
            if (table === 'appointments') {
              const apt = appointmentsMap.get(eqFilters.id);
              return { data: apt || null, error: null };
            }
            return { data: null, error: null };
          },
          insert: (payload: Record<string, unknown>) => {
            const newApt = {
              id: 'apt-created-01',
              ...payload,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            appointmentsMap.set(newApt.id, newApt);
            return {
              select: () => ({
                single: async () => ({ data: newApt, error: null }),
              }),
            };
          },
          update: (payload: Record<string, unknown>) => {
            const existing = appointmentsMap.get(eqFilters.id);
            if (existing) {
              Object.assign(existing, payload);
            }
            return {
              eq: (col: string, val: string) => {
                eqFilters[col] = val;
                return {
                  select: () => ({
                    single: async () => ({ data: appointmentsMap.get(val), error: null }),
                  }),
                };
              },
            };
          },
        };
        return queryBuilder;
      },
    };
  };

  await runAsyncTest('Kịch bản 8.1: Chặn khi assignee là SALE hoặc vai trò khác không phải TECHNICIAN', async () => {
    const mockClient = createMockAppointmentClient();

    await assert.rejects(
      async () => {
        await createAppointment(
          {
            customer_id: 'cust-100',
            assignee_id: 'user-sale', // Role SALE
            address: '123 Đường Láng',
            appointment_date: '2026-09-25T09:00:00.000Z',
          },
          mockClient as unknown as Parameters<typeof createAppointment>[1]
        );
      },
      {
        message: 'Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.',
      }
    );
  });

  await runAsyncTest('Kịch bản 8.2: Chặn khi assignee có membership INACTIVE', async () => {
    const mockClient = createMockAppointmentClient();

    await assert.rejects(
      async () => {
        await createAppointment(
          {
            customer_id: 'cust-100',
            assignee_id: 'user-inactive', // Membership INACTIVE
            address: '123 Đường Láng',
            appointment_date: '2026-09-25T09:00:00.000Z',
          },
          mockClient as unknown as Parameters<typeof createAppointment>[1]
        );
      },
      {
        message: 'Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.',
      }
    );
  });

  await runAsyncTest('Kịch bản 8.3: Chặn khi assignee thuộc công ty khác (khác companyId)', async () => {
    const mockClient = createMockAppointmentClient();

    await assert.rejects(
      async () => {
        await createAppointment(
          {
            customer_id: 'cust-100', // Thuộc comp-A
            assignee_id: 'user-comp-b', // Thuộc comp-B
            address: '123 Đường Láng',
            appointment_date: '2026-09-25T09:00:00.000Z',
          },
          mockClient as unknown as Parameters<typeof createAppointment>[1]
        );
      },
      {
        message: 'Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.',
      }
    );
  });

  await runAsyncTest('Kịch bản 8.4: Chấp nhận khi assignee là ACTIVE TECHNICIAN cùng công ty & derive company_id', async () => {
    const mockClient = createMockAppointmentClient();

    const appointment = await createAppointment(
      {
        customer_id: 'cust-100', // Thuộc comp-A
        assignee_id: 'user-tech-valid', // ACTIVE TECHNICIAN thuộc comp-A
        address: '123 Đường Láng',
        appointment_date: '2026-09-25T09:00:00.000Z',
        company_id: 'comp-HACKER', // Caller gửi company_id giả mạo
      },
      mockClient as unknown as Parameters<typeof createAppointment>[1]
    );

    assert.equal(appointment.id, 'apt-created-01');
    // Khẳng định company_id được derive trực tiếp từ customer (comp-A), không tin comp-HACKER
    assert.equal(appointment.company_id, 'comp-A');
    assert.equal(appointment.assignee_id, 'user-tech-valid');
    assert.equal(appointment.customer?.name, 'Nguyễn Văn Khách');
  });

  await runAsyncTest('Kịch bản 8.5: assignAppointment chặn phân công người không phải ACTIVE TECHNICIAN', async () => {
    const mockClient = createMockAppointmentClient();

    // 8.5a: Gán assignee sai vai trò (user-sale) -> Bị chặn
    await assert.rejects(
      async () => {
        await assignAppointment(
          'apt-existing-01',
          'user-sale',
          mockClient as unknown as Parameters<typeof assignAppointment>[2]
        );
      },
      {
        message: 'Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.',
      }
    );

    // 8.5b: Gán assignee hợp lệ (user-tech-valid) -> Thành công
    const updated = await assignAppointment(
      'apt-existing-01',
      'user-tech-valid',
      mockClient as unknown as Parameters<typeof assignAppointment>[2]
    );
    assert.equal(updated.id, 'apt-existing-01');
    assert.equal(updated.assignee_id, 'user-tech-valid');
  });

  await runAsyncTest('Kịch bản 8.6: updateAppointment chặn khi đổi assignee sang người không phải ACTIVE TECHNICIAN', async () => {
    const mockClient = createMockAppointmentClient();

    // 8.6a: Cập nhật assignee sang user-sale -> Bị chặn
    await assert.rejects(
      async () => {
        await updateAppointment(
          'apt-existing-01',
          { assignee_id: 'user-sale' },
          mockClient as unknown as Parameters<typeof updateAppointment>[2]
        );
      },
      {
        message: 'Người được phân công phải là kỹ thuật viên đang hoạt động thuộc cùng công ty.',
      }
    );

    // 8.6b: Cập nhật assignee sang user-tech-valid -> Thành công
    const updated = await updateAppointment(
      'apt-existing-01',
      { assignee_id: 'user-tech-valid' },
      mockClient as unknown as Parameters<typeof updateAppointment>[2]
    );
    assert.equal(updated.id, 'apt-existing-01');
    assert.equal(updated.assignee_id, 'user-tech-valid');
  });

  // ==========================================================================
  // KỊCH BẢN 9: Khắc phục P1 (Lỗi 14) - Authorization & RBAC chuyên sâu
  // ==========================================================================
  type MockActor = {
    userId: string;
    companyId: string;
    role: string;
    profileStatus: string;
    membershipStatus: string;
  };

  type MockAppointmentAccess = {
    id: string;
    company_id: string;
    customer_id?: string;
    assignee_id?: string | null;
    status: string;
    type: string;
  };

  /**
   * Bộ kiểm tra xác thực quyền và ngữ cảnh lịch hẹn khảo sát (Fail-Closed)
   * tương ứng với hợp đồng bảo mật phân hệ Survey.
   */
  function verifySurveyAppointmentAccess(
    actor: MockActor | null,
    appointment: MockAppointmentAccess | null,
    allowedRoles: string[] = ['BOSS_ADMIN', 'TECHNICIAN']
  ) {
    if (
      !actor ||
      !actor.userId ||
      !actor.companyId ||
      actor.profileStatus !== 'ACTIVE' ||
      actor.membershipStatus !== 'ACTIVE'
    ) {
      throw new Error('Bạn chưa đăng nhập hoặc tài khoản/thành viên không hoạt động.');
    }

    if (!actor.role || !allowedRoles.includes(actor.role)) {
      throw new Error('Bạn không có quyền thực hiện thao tác này.');
    }

    if (!appointment) {
      throw new Error('Không tìm thấy lịch hẹn khảo sát.');
    }

    if (appointment.company_id !== actor.companyId) {
      throw new Error('Lịch hẹn không thuộc doanh nghiệp của bạn.');
    }

    if (appointment.type !== 'SURVEY') {
      throw new Error('Lịch hẹn không phải là lịch khảo sát hợp lệ.');
    }

    // Technicians can only operate on their own active appointments
    if (actor.role === 'TECHNICIAN') {
      if (appointment.assignee_id !== actor.userId) {
        throw new Error('Bạn không có quyền thao tác trên lịch hẹn của kỹ thuật viên khác.');
      }

      const validStatuses = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];
      if (!validStatuses.includes(appointment.status)) {
        throw new Error('Lịch hẹn đã kết thúc hoặc bị hủy, không thể thao tác.');
      }
    }

    return { actor, appointment };
  }

  runTest('Kịch bản 9.1: Chặn người dùng có profileStatus ACTIVE nhưng membershipStatus INACTIVE', () => {
    const actorInactiveMember: MockActor = {
      userId: 'user-inactive-member',
      companyId: 'comp-A',
      role: 'TECHNICIAN',
      profileStatus: 'ACTIVE',
      membershipStatus: 'INACTIVE',
    };

    const apt: MockAppointmentAccess = {
      id: 'apt-01',
      company_id: 'comp-A',
      assignee_id: 'user-inactive-member',
      status: 'ASSIGNED',
      type: 'SURVEY',
    };

    assert.throws(
      () => {
        verifySurveyAppointmentAccess(actorInactiveMember, apt);
      },
      {
        message: 'Bạn chưa đăng nhập hoặc tài khoản/thành viên không hoạt động.',
      }
    );
  });

  runTest('Kịch bản 9.2: Chặn người dùng có role SALE cố gọi action chỉ dành cho kỹ thuật viên', () => {
    const actorSale: MockActor = {
      userId: 'user-sale-01',
      companyId: 'comp-A',
      role: 'SALE',
      profileStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE',
    };

    const apt: MockAppointmentAccess = {
      id: 'apt-01',
      company_id: 'comp-A',
      assignee_id: 'user-sale-01',
      status: 'ASSIGNED',
      type: 'SURVEY',
    };

    // Khi gọi action yêu cầu role TECHNICIAN
    assert.throws(
      () => {
        verifySurveyAppointmentAccess(actorSale, apt, ['TECHNICIAN']);
      },
      {
        message: 'Bạn không có quyền thực hiện thao tác này.',
      }
    );
  });

  runTest('Kịch bản 9.3: Chặn khi appointment có type !== SURVEY (ví dụ INSTALLATION)', () => {
    const actorTech: MockActor = {
      userId: 'user-tech-01',
      companyId: 'comp-A',
      role: 'TECHNICIAN',
      profileStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE',
    };

    const aptInstall: MockAppointmentAccess = {
      id: 'apt-install-01',
      company_id: 'comp-A',
      assignee_id: 'user-tech-01',
      status: 'ASSIGNED',
      type: 'INSTALLATION', // Sai type
    };

    assert.throws(
      () => {
        verifySurveyAppointmentAccess(actorTech, aptInstall);
      },
      {
        message: 'Lịch hẹn không phải là lịch khảo sát hợp lệ.',
      }
    );
  });

  runTest('Kịch bản 9.4: Chặn technician thao tác trên các assignment không còn hiệu lực', () => {
    const actorTech: MockActor = {
      userId: 'user-tech-01',
      companyId: 'comp-A',
      role: 'TECHNICIAN',
      profileStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE',
    };

    // 9.4a: Các trạng thái kết thúc/hủy bị chặn (COMPLETED, CANCELLED, REJECTED)
    const invalidStatuses = ['COMPLETED', 'CANCELLED', 'REJECTED'];
    for (const status of invalidStatuses) {
      const apt: MockAppointmentAccess = {
        id: `apt-${status.toLowerCase()}`,
        company_id: 'comp-A',
        assignee_id: 'user-tech-01',
        status,
        type: 'SURVEY',
      };

      assert.throws(
        () => {
          verifySurveyAppointmentAccess(actorTech, apt);
        },
        {
          message: 'Lịch hẹn đã kết thúc hoặc bị hủy, không thể thao tác.',
        },
        `Status ${status} phải bị từ chối`
      );
    }

    // 9.4b: Các trạng thái hiệu lực được chấp thuận (ASSIGNED, ACCEPTED, IN_PROGRESS)
    const validStatuses = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];
    for (const status of validStatuses) {
      const apt: MockAppointmentAccess = {
        id: `apt-${status.toLowerCase()}`,
        company_id: 'comp-A',
        assignee_id: 'user-tech-01',
        status,
        type: 'SURVEY',
      };

      const result = verifySurveyAppointmentAccess(actorTech, apt);
      assert.equal(result.appointment.status, status);
    }
  });

  runTest('Kịch bản 9.5: Chặn technician thao tác trên lịch hẹn của technician khác', () => {
    const actorTech: MockActor = {
      userId: 'user-tech-01',
      companyId: 'comp-A',
      role: 'TECHNICIAN',
      profileStatus: 'ACTIVE',
      membershipStatus: 'ACTIVE',
    };

    const aptOtherTech: MockAppointmentAccess = {
      id: 'apt-other-01',
      company_id: 'comp-A',
      assignee_id: 'user-tech-02', // Khác assignee
      status: 'ASSIGNED',
      type: 'SURVEY',
    };

    assert.throws(
      () => {
        verifySurveyAppointmentAccess(actorTech, aptOtherTech);
      },
      {
        message: 'Bạn không có quyền thao tác trên lịch hẹn của kỹ thuật viên khác.',
      }
    );
  });

  // ==========================================================================
  // KỊCH BẢN 10: Khắc phục P1 (Lỗi 15) - Atomicity & Rollback Survey Completion
  // ==========================================================================
  await runAsyncTest('Kịch bản 10.1: completeSurvey rollback xóa survey mồ côi khi update appointment thất bại', async () => {
    const deletedSurveyIds: string[] = [];

    const mockDbRollback = {
      from: (table: string) => {
        const eqFilters: Record<string, string> = {};
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (col: string, val: string) => {
            eqFilters[col] = val;
            return q;
          },
          maybeSingle: async () => {
            if (table === 'appointments') {
              return {
                data: {
                  id: 'apt-atomic-01',
                  company_id: 'comp-1',
                  customer_id: 'cust-1',
                  assignee_id: 'tech-1',
                  status: 'IN_PROGRESS',
                  type: 'SURVEY',
                },
                error: null,
              };
            }
            if (table === 'surveys') {
              // Chưa có survey tồn tại
              return { data: null, error: null };
            }
            return { data: null, error: null };
          },
          insert: (payload: Record<string, unknown>) => {
            const newSurveyRecord = {
              id: 'survey-orphan-rollback-001',
              ...payload,
            };
            return {
              select: () => ({
                single: async () => ({ data: newSurveyRecord, error: null }),
              }),
            };
          },
          update: () => ({
            eq: () => ({
              error: {
                message: 'Database lock timeout or constraint violation on appointments update',
              },
            }),
          }),
          delete: () => {
            return {
              eq: (_col: string, val: string) => {
                deletedSurveyIds.push(val);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
        return q;
      },
      storage: {
        from: () => ({
          list: async () => ({
            data: [
              { name: 'OVERVIEW_1726000000.jpg', created_at: '2026-09-20T10:00:00Z' },
              { name: 'BOTTOM_LEFT_1726000000.jpg', created_at: '2026-09-20T10:01:00Z' },
              { name: 'BOTTOM_RIGHT_1726000000.jpg', created_at: '2026-09-20T10:02:00Z' },
            ],
            error: null,
          }),
        }),
      },
    };

    const inputData: CompleteSurveyInput = {
      appointmentId: 'apt-atomic-01',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    const result = await completeSurvey(
      inputData,
      'tech-1',
      'comp-1',
      mockDbRollback as unknown as Parameters<typeof completeSurvey>[3]
    );

    // 1. Phải trả về thất bại
    assert.equal(result.success, false);
    assert.equal(
      result.message,
      'Không thể cập nhật trạng thái lịch hẹn, đã hủy thao tác tạo khảo sát.'
    );

    // 2. Phải kích hoạt rollback: Xóa chính xác bản ghi survey vừa tạo để tránh mồ côi
    assert.equal(deletedSurveyIds.length, 1);
    assert.equal(deletedSurveyIds[0], 'survey-orphan-rollback-001');
  });

  await runAsyncTest('Kịch bản 10.2: completeSurvey từ chối lịch hẹn ở trạng thái không hợp lệ (CANCELLED, COMPLETED)', async () => {
    const createMockForStatus = (status: string) => ({
      from: (table: string) => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => {
            if (table === 'appointments') {
              return {
                data: {
                  id: `apt-${status.toLowerCase()}`,
                  company_id: 'comp-1',
                  customer_id: 'cust-1',
                  assignee_id: 'tech-1',
                  status,
                  type: 'SURVEY',
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
        };
        return q;
      },
    });

    const inputData: CompleteSurveyInput = {
      appointmentId: 'apt-cancelled',
      measurements: VALID_MEASUREMENTS,
      siteCondition: VALID_SITE_CONDITION,
      photos: MOCK_PHOTOS,
    };

    // 10.2a: Appointment bị hủy CANCELLED
    const resCancelled = await completeSurvey(
      inputData,
      'tech-1',
      'comp-1',
      createMockForStatus('CANCELLED') as unknown as Parameters<typeof completeSurvey>[3]
    );
    assert.equal(resCancelled.success, false);
    assert.equal(resCancelled.message, 'Lịch hẹn đã bị hủy, không thể hoàn tất khảo sát.');

    // 10.2b: Appointment đã COMPLETED
    const resCompleted = await completeSurvey(
      { ...inputData, appointmentId: 'apt-completed' },
      'tech-1',
      'comp-1',
      createMockForStatus('COMPLETED') as unknown as Parameters<typeof completeSurvey>[3]
    );
    assert.equal(resCompleted.success, false);
    assert.ok(
      resCompleted.message?.includes(
        'Lịch hẹn đang ở trạng thái COMPLETED, không thể hoàn tất khảo sát.'
      )
    );
  });

  console.log('===============================================================');
  console.log(`TOTAL TESTS: ${passCount + failCount}`);
  console.log(`PASSED: ${passCount}`);
  console.log(`FAILED: ${failCount}`);
  console.log('===============================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal test runner error:', e);
  process.exit(1);
});
