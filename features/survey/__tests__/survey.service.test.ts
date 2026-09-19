import assert from 'node:assert/strict';
import {
  validateSurveyCompletionGate,
  formatSurveyForPricing,
  getSurveyForPricing,
} from '../services/survey.service';
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
