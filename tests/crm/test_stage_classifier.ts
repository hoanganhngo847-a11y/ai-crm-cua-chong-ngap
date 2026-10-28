import assert from 'node:assert';
import {
  classifyCustomerStage,
  type StageClassifierInput,
  type StageClassifierSource,
} from '../../features/crm/stage-classifier';
import { normalizeVietnamese } from '../../features/crm/stage-classifier/normalize';

let passCount = 0;
let failCount = 0;

function check(condition: boolean, message: string) {
  if (condition) {
    passCount++;
    console.log(`✓ PASS: ${message}`);
  } else {
    failCount++;
    console.error(`✗ FAIL: ${message}`);
  }
}

function source(
  id: string,
  content: string,
  overrides: Partial<StageClassifierSource> = {}
): StageClassifierSource {
  return {
    id,
    sourceType: 'INTERACTION',
    channel: 'FACEBOOK',
    speaker: 'CUSTOMER',
    content,
    occurredAt: '2026-10-20T03:00:00.000Z',
    ...overrides,
  };
}

function classify(
  content: string | null,
  options: {
    source?: string;
    stage?: string;
    speaker?: StageClassifierSource['speaker'];
    channel?: string;
    sources?: StageClassifierSource[];
  } = {}
) {
  const input: StageClassifierInput = {
    customer: {
      stage: options.stage || 'awareness',
      source: options.source || 'FACEBOOK',
    },
    sources:
      options.sources ||
      (content === null
        ? []
        : [
            source('src-1', content, {
              channel: options.channel || 'FACEBOOK',
              speaker: options.speaker || 'CUSTOMER',
            }),
          ]),
  };
  return classifyCustomerStage(input);
}

function run() {
  console.log('='.repeat(70));
  console.log('STAGE CLASSIFIER SAFETY TESTS');
  console.log('='.repeat(70));

  // ---------------------------------------------------------------------------
  console.log('\n--- 1. Source prior is only a weak initial suggestion ---');
  check(classify(null, { source: 'FACEBOOK' }).suggestedStage === 'awareness', 'FACEBOOK with no messages → awareness');
  check(classify(null, { source: 'ZALO' }).suggestedStage === 'interested', 'ZALO with no messages → interested');
  check(classify(null, { source: 'ZALO_OA' }).suggestedStage === 'interested', 'ZALO_OA with no messages → interested');
  check(classify(null, { source: 'WEBSITE' }).suggestedStage === 'interested', 'WEBSITE with no messages → interested');
  check(classify(null, { source: 'HOTLINE' }).suggestedStage === 'awareness', 'HOTLINE with no messages → awareness');
  check(classify(null, { source: 'UNKNOWN_SOURCE' }).suggestedStage === 'awareness', 'Unknown source falls back to awareness');

  const zaloPrior = classify(null, { source: 'ZALO' });
  check(zaloPrior.sourceRuleApplied === true, 'No-signal result marks sourceRuleApplied=true');
  check(zaloPrior.confidence <= 0.4, 'Source-only suggestion confidence is capped at 0.4');
  check(zaloPrior.evidenceItems.length === 0, 'No sources means no fabricated evidence items');

  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Strong conversation evidence overrides the source rule ---');
  check(
    classify('Tôi đã chọn bên khác rồi.', { source: 'ZALO' }).suggestedStage === 'low_potential',
    'ZALO + "đã chọn bên khác" → low_potential (overrides interested prior)'
  );
  check(
    classify('Tôi đã ký hợp đồng rồi.', { source: 'ZALO' }).suggestedStage === 'contract_signed',
    'ZALO + explicit signed contract → contract_signed'
  );
  check(
    classify('Cho tôi xin thông số kỹ thuật và bản vẽ thi công.', { source: 'FACEBOOK' })
      .suggestedStage === 'deep_research',
    'Technical documents question → deep_research'
  );
  check(
    classify('Không có nhu cầu, đừng liên hệ nữa.', { source: 'ZALO' }).suggestedStage ===
      'low_potential',
    'Explicit no-demand → low_potential'
  );

  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Contract-signed false positives are downgraded ---');
  const contractFalsePositives = [
    'Tôi muốn ký hợp đồng.',
    'Chờ ký hợp đồng bên anh gửi.',
    'Gửi hợp đồng cho tôi xem trước.',
    'Soạn hợp đồng giúp tôi nhé.',
    'Tôi sẽ ký hợp đồng vào tuần sau.',
    'Dự định ký hợp đồng tháng sau.',
    'Chưa ký hợp đồng đâu.',
    'Không ký hợp đồng này.',
    'Bản hợp đồng đã soạn xong chưa?',
    'Hóa đơn này xuất cho công ty tôi.',
    'Đã ký gửi hàng cho anh rồi nhé.',
  ];

  for (const text of contractFalsePositives) {
    const result = classify(text, { source: 'ZALO' });
    check(
      result.suggestedStage !== 'contract_signed',
      `"${text}" is NOT classified as contract_signed (got ${result.suggestedStage})`
    );
    check(
      result.evidenceItems.every((item) => item.stage !== 'contract_signed'),
      `"${text}" produces no contract_signed evidence item`
    );
  }

  check(
    classify('Tôi muốn ký hợp đồng.', { source: 'ZALO' }).suggestedStage === 'high_potential',
    '"muốn ký hợp đồng" → high_potential'
  );
  check(
    classify('Chờ ký hợp đồng bên anh gửi.', { source: 'ZALO' }).suggestedStage ===
      'high_potential',
    '"chờ ký hợp đồng" → high_potential'
  );
  check(
    classify('Gửi hợp đồng cho tôi xem trước.', { source: 'ZALO' }).suggestedStage ===
      'high_potential',
    '"gửi hợp đồng" → high_potential'
  );
  check(
    classify('Đã ký gửi hàng cho anh rồi nhé.', { source: 'ZALO' }).suggestedStage ===
      'high_potential',
    'Bare "đã ký" without contract context → high_potential'
  );

  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Real signed-contract evidence still wins ---');
  const signedCases = [
    'Tôi đã ký hợp đồng rồi.',
    'Hợp đồng đã ký, anh triển khai giúp tôi.',
    'Đã ký xong hợp đồng với công ty mình.',
    'Công trình đã thi công xong và nghiệm thu rồi.',
    'Bên anh đã bàn giao máy cho tôi.',
  ];

  for (const text of signedCases) {
    const result = classify(text, { source: 'FACEBOOK' });
    check(
      result.suggestedStage === 'contract_signed',
      `"${text}" → contract_signed (got ${result.suggestedStage})`
    );
    check(
      result.evidenceItems.some(
        (item) => item.stage === 'contract_signed' && item.signal.startsWith('contract_')
      ),
      `"${text}" carries explicit contract evidence`
    );
    check(result.confidence <= 0.85, `"${text}" confidence capped at 0.85`);
  }

  check(
    classify('Tôi đã ký hợp đồng với bên khác.', { source: 'ZALO' }).suggestedStage ===
      'low_potential',
    '"đã ký với bên khác" → low_potential, not contract_signed'
  );

  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Evidence is grounded in real source text ---');
  const grounded = classify(
    'Tôi muốn lắp cửa chống ngập. Giá bao nhiêu tiền vậy?',
    { source: 'ZALO' }
  );
  const joined = normalizeVietnamese(grounded.evidenceItems.map((item) => item.quote).join(' '));
  for (const item of grounded.evidenceItems) {
    check(
      joined.includes(normalizeVietnamese(item.quote)),
      `Evidence quote is taken from source: "${item.quote}"`
    );
    check(item.occurredAt === '2026-10-20T03:00:00.000Z', 'Evidence keeps the source timestamp');
    check(item.source === 'FACEBOOK', 'Evidence keeps the source channel');
  }
  check(grounded.evidenceItems.length > 0, 'Signals produce grounded evidence items');
  check(grounded.objections.length === 0, 'No objection is invented when none was stated');

  const objection = classify('Giá hơi đắt, để tôi suy nghĩ thêm.', { source: 'ZALO' });
  check(objection.objections.length > 0, 'Explicit price objection is captured');
  check(
    objection.objections.some((text) => normalizeVietnamese(text).includes('dat')),
    'Objection keeps the original customer wording'
  );

  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Current stage normalization and no-op reasoning ---');
  const legacyCurrent = classify('Giá bao nhiêu tiền?', {
    source: 'ZALO',
    stage: 'PRICE_OFFERED',
  });
  check(legacyCurrent.currentStage === 'high_potential', 'Legacy current stage is normalized');
  check(
    legacyCurrent.reason.includes('Đề xuất chuyển từ') || legacyCurrent.reason.includes('Giữ nguyên'),
    'Reason explains the proposed transition'
  );

  const sameStage = classify('Giá bao nhiêu tiền?', {
    source: 'ZALO',
    stage: 'interested',
  });
  check(sameStage.suggestedStage === 'interested', 'Current interested + price question stays interested');
  check(sameStage.reason.includes('Giữ nguyên'), 'Reason states the stage is unchanged');
  check(sameStage.requiresVerification === true, 'Every AI suggestion requires human verification');

  // ---------------------------------------------------------------------------
  console.log('\n--- 7. Bounds and deterministic output ---');
  for (const text of ['', '   ', 'hello', 'Tôi đã ký hợp đồng rồi.']) {
    const result = classify(text, { source: 'ZALO' });
    check(
      result.confidence >= 0.2 && result.confidence <= 0.92,
      `Confidence stays within [0.2, 0.92] for "${text}" (got ${result.confidence})`
    );
    check(result.classifierVersion === 'stage-rules-v1', 'Classifier version is stable');
    check(
      result.suggestedStage ===
        classify(text, { source: 'ZALO' }).suggestedStage,
      `Classification is deterministic for "${text}"`
    );
  }

  console.log('\n' + '='.repeat(70));
  console.log(`RESULT: ${passCount} passed, ${failCount} failed`);
  console.log('='.repeat(70));

  if (failCount > 0) {
    process.exit(1);
  }
}

run();
