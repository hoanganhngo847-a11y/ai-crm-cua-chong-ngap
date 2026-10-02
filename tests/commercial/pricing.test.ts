import assert from 'node:assert';
import { calculatePrice } from '../../features/pricing/utils';
import {
  convertMillimetersToMeters,
  adaptSurveyToPricingInput,
} from '../../features/survey/adapters/pricing.adapter';

console.log('================================================================');
console.log('STARTING TV7 PRICING ENGINE & SNAPSHOT IMMUTABILITY TESTS');
console.log('================================================================\n');

let passCount = 0;
function testPass(msg: string) {
  console.log(`[PASS] ${msg}`);
  passCount++;
}

// ----------------------------------------------------------------------------
// Test 1: Valid canonical pricing policy calculation
// ----------------------------------------------------------------------------
{
  const measurements = { width: 2.5, height: 1.2 };
  const policy = {
    price_rules: {
      base_price_per_sqm: 5000000,
    },
    conditions: {
      deposit_percentage: 30,
    },
  };

  const result = calculatePrice(measurements, policy);
  assert.strictEqual(result.status, 'CALCULATED');
  assert.strictEqual(result.amount, 15000000); // 2.5 * 1.2 * 5,000,000 = 15,000,000
  assert.deepStrictEqual(result.missing_fields, []);
  testPass('Valid measurements and pricing policy produce exact canonical amount');
}

// ----------------------------------------------------------------------------
// Test 2: Missing required inputs (width, height) returns NEED_INFO with amount = null
// ----------------------------------------------------------------------------
{
  const policy = {
    price_rules: { base_price_per_sqm: 4000000 },
  };

  // Case A: Missing width
  const res1 = calculatePrice({ height: 1.5 }, policy);
  assert.strictEqual(res1.status, 'NEED_INFO');
  assert.strictEqual(res1.amount, null);
  assert(res1.missing_fields.includes('width'));

  // Case B: Missing height
  const res2 = calculatePrice({ width: 2.0 }, policy);
  assert.strictEqual(res2.status, 'NEED_INFO');
  assert.strictEqual(res2.amount, null);
  assert(res2.missing_fields.includes('height'));

  // Case C: Missing both
  const res3 = calculatePrice({}, policy);
  assert.strictEqual(res3.status, 'NEED_INFO');
  assert.strictEqual(res3.amount, null);
  assert(res3.missing_fields.includes('width'));
  assert(res3.missing_fields.includes('height'));

  testPass('Missing dimensions return NEED_INFO, amount = null, and exact missing_fields list');
}

// ----------------------------------------------------------------------------
// Test 3: Missing base_price_per_sqm in policy returns NEED_INFO
// ----------------------------------------------------------------------------
{
  const measurements = { width: 3.0, height: 1.5 };
  const invalidPolicy = { price_rules: {} };

  const result = calculatePrice(measurements, invalidPolicy);
  assert.strictEqual(result.status, 'NEED_INFO');
  assert.strictEqual(result.amount, null);
  assert(result.missing_fields.includes('base_price_per_sqm'));
  testPass('Missing policy price rules returns NEED_INFO without guessing default price');
}

// ----------------------------------------------------------------------------
// Test 4: Zero or negative measurements return NEED_INFO (No guessed dimensions)
// ----------------------------------------------------------------------------
{
  const policy = {
    price_rules: { base_price_per_sqm: 3500000 },
  };

  const resZero = calculatePrice({ width: 0, height: 2 }, policy);
  assert.strictEqual(resZero.status, 'NEED_INFO');
  assert.strictEqual(resZero.amount, null);
  assert(resZero.missing_fields.includes('width'));

  const resNeg = calculatePrice({ width: 2, height: -1 }, policy);
  assert.strictEqual(resNeg.status, 'NEED_INFO');
  assert.strictEqual(resNeg.amount, null);
  assert(resNeg.missing_fields.includes('height'));

  testPass('Invalid, non-positive dimensions are rejected fail-closed');
}

// ----------------------------------------------------------------------------
// Test 5: Verify no hardcoded deposit percentage in calculation logic
// ----------------------------------------------------------------------------
{
  const policy = {
    price_rules: { base_price_per_sqm: 1000000 },
    conditions: { deposit_percentage: 45 },
  };
  const result = calculatePrice({ width: 1, height: 1 }, policy);
  assert.strictEqual(result.amount, 1000000);
  testPass('Pricing calculator does not hardcode deposit percentages or arbitrary discounts');
}

// ----------------------------------------------------------------------------
// Test 6: Canonical Survey → Pricing contract (Section 8)
// 2500 mm -> 2.5 m, 1200 mm -> 1.2 m, formula 2.5 * 1.2 * price_per_sqm = 15,000,000
// NOT 2500 * 1200 * price_per_sqm
// ----------------------------------------------------------------------------
{
  // 1. Direct unit conversion tests
  const widthM = convertMillimetersToMeters(2500);
  const heightM = convertMillimetersToMeters(1200);
  assert.strictEqual(widthM, 2.5, '2500 mm must convert to exactly 2.5 m');
  assert.strictEqual(heightM, 1.2, '1200 mm must convert to exactly 1.2 m');

  // 2. Real Survey record adapter
  const surveyRecord = {
    id: 'srv-contract-test-01',
    company_id: 'comp-01',
    customer_id: 'cust-01',
    appointment_id: 'apt-01',
    measurements: {
      clear_width_mm: 2500,
      barrier_height_mm: 1200,
      anticipated_flood_height_mm: 800,
      gate_type: 'REMOVABLE_PANEL' as const,
      mounting_method: 'INSIDE_JAMB' as const,
    },
    site_condition: {
      wall_material: 'SOLID_BRICK',
      floor_material: 'CONCRETE_SMOOTH',
      floor_evenness: 'FLAT',
      slope_grade: 'LEVEL',
    },
    photos: [],
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
  };

  const adapted = adaptSurveyToPricingInput(surveyRecord);
  assert.strictEqual(adapted.width, 2.5);
  assert.strictEqual(adapted.height, 1.2);
  assert.strictEqual(adapted.unit, 'm');
  assert.strictEqual(adapted.survey_id, 'srv-contract-test-01');

  // 3. Pricing calculation via canonical policy
  const policy = {
    price_rules: {
      base_price_per_sqm: 5000000,
    },
    conditions: {
      deposit_percentage: 30,
    },
  };

  const calcResult = calculatePrice(adapted, policy);
  assert.strictEqual(calcResult.status, 'CALCULATED');
  assert.strictEqual(calcResult.amount, 15000000); // 2.5 * 1.2 * 5,000,000 = 15,000,000
  // Assert explicit rejection of millimeter multiplication (2500 * 1200 * 5,000,000 = 15,000,000,000,000)
  assert.notStrictEqual(calcResult.amount, 2500 * 1200 * 5000000);
  assert.deepStrictEqual(calcResult.missing_fields, []);

  testPass('Canonical Survey-to-Pricing adapter: 2500 mm -> 2.5 m, 1200 mm -> 1.2 m, amount = 15,000,000 (not millimeter multiplication)');
}

// ----------------------------------------------------------------------------
// Test 7: Missing survey measurements produce fail-closed NEED_INFO without guessing
// ----------------------------------------------------------------------------
{
  const incompleteSurvey = {
    id: 'srv-contract-test-missing',
    company_id: 'comp-01',
    customer_id: 'cust-01',
    appointment_id: 'apt-02',
    measurements: {
      clear_width_mm: 2500,
      // barrier_height_mm missing!
    },
    site_condition: {},
    photos: [],
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
  };

  const adapted = adaptSurveyToPricingInput(incompleteSurvey);
  assert.strictEqual(adapted.width, 2.5);
  assert.strictEqual(adapted.height, undefined);

  const policy = {
    price_rules: {
      base_price_per_sqm: 5000000,
    },
  };

  const calcResult = calculatePrice(adapted, policy);
  assert.strictEqual(calcResult.status, 'NEED_INFO');
  assert.strictEqual(calcResult.amount, null);
  assert.deepStrictEqual(calcResult.missing_fields, ['height']);
  testPass('Missing survey dimension produces NEED_INFO, amount = null, exact missing_fields (no guessed values)');
}

console.log(`\n================================================================`);
console.log(`PRICING UNIT TESTS COMPLETED: ${passCount} PASSED, 0 FAILED`);
console.log(`================================================================\n`);
