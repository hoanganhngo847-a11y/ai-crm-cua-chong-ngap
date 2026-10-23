import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOVER_PRIORITIES,
  HANDOVER_REASONS,
  type HandoverPriority,
  type HandoverReason,
} from '../../features/ai-brain/handover/contracts';
import { classifyHandoverReason } from '../../features/ai-brain/handover/classifier';

test('Handover Classifier: covers all standardized HandoverReason and HandoverPriority enums', () => {
  assert.equal(HANDOVER_REASONS.length, 10);
  assert.deepEqual(HANDOVER_REASONS, [
    'CUSTOMER_REQUESTED_HUMAN',
    'CUSTOMER_COMPLAINT',
    'REFUND_REQUEST',
    'PRICE_QUOTATION_REQUIRED',
    'LEGAL_OR_POLICY',
    'PAYMENT_ISSUE',
    'LOW_CONFIDENCE',
    'INSUFFICIENT_KNOWLEDGE',
    'HIGH_VALUE_LEAD',
    'OTHER',
  ]);

  assert.equal(HANDOVER_PRIORITIES.length, 4);
  assert.deepEqual(HANDOVER_PRIORITIES, ['URGENT', 'HIGH', 'NORMAL', 'LOW']);
});

test('Handover Classifier: maps exact canonical reason to expected canonical priority', () => {
  const expectedMap: Record<HandoverReason, HandoverPriority> = {
    REFUND_REQUEST: 'URGENT',
    CUSTOMER_COMPLAINT: 'HIGH',
    PAYMENT_ISSUE: 'HIGH',
    LEGAL_OR_POLICY: 'HIGH',
    HIGH_VALUE_LEAD: 'HIGH',
    CUSTOMER_REQUESTED_HUMAN: 'NORMAL',
    PRICE_QUOTATION_REQUIRED: 'NORMAL',
    LOW_CONFIDENCE: 'NORMAL',
    INSUFFICIENT_KNOWLEDGE: 'NORMAL',
    OTHER: 'LOW',
  };

  for (const reason of HANDOVER_REASONS) {
    const result = classifyHandoverReason(reason);
    assert.equal(result.reason, reason);
    assert.equal(
      result.priority,
      expectedMap[reason],
      `Expected ${reason} to have priority ${expectedMap[reason]}`
    );
  }
});

test('Handover Classifier: normalizes casing and separators', () => {
  assert.deepEqual(classifyHandoverReason('customer_complaint'), {
    reason: 'CUSTOMER_COMPLAINT',
    priority: 'HIGH',
  });
  assert.deepEqual(classifyHandoverReason('refund-request'), {
    reason: 'REFUND_REQUEST',
    priority: 'URGENT',
  });
  assert.deepEqual(classifyHandoverReason(' price quotation required '), {
    reason: 'PRICE_QUOTATION_REQUIRED',
    priority: 'NORMAL',
  });
});

test('Handover Classifier: maps keywords, synonyms and Vietnamese terms', () => {
  // Refund / Hoàn tiền -> REFUND_REQUEST (URGENT)
  assert.deepEqual(classifyHandoverReason('khách yêu cầu hoàn tiền'), {
    reason: 'REFUND_REQUEST',
    priority: 'URGENT',
  });
  assert.deepEqual(classifyHandoverReason('tra_hang_hoan_tien'), {
    reason: 'REFUND_REQUEST',
    priority: 'URGENT',
  });

  // Complaint / Khiếu nại -> CUSTOMER_COMPLAINT (HIGH)
  assert.deepEqual(classifyHandoverReason('khách khiếu nại dịch vụ'), {
    reason: 'CUSTOMER_COMPLAINT',
    priority: 'HIGH',
  });
  assert.deepEqual(classifyHandoverReason('CUSTOMER_ANGRY_COMPLAINT'), {
    reason: 'CUSTOMER_COMPLAINT',
    priority: 'HIGH',
  });

  // Payment -> PAYMENT_ISSUE (HIGH)
  assert.deepEqual(classifyHandoverReason('lỗi thanh toán chuyển khoản'), {
    reason: 'PAYMENT_ISSUE',
    priority: 'HIGH',
  });
  assert.deepEqual(classifyHandoverReason('PAYMENT_GATEWAY_DISPUTE'), {
    reason: 'PAYMENT_ISSUE',
    priority: 'HIGH',
  });

  // Legal -> LEGAL_OR_POLICY (HIGH)
  assert.deepEqual(classifyHandoverReason('khách dọa kiện pháp lý'), {
    reason: 'LEGAL_OR_POLICY',
    priority: 'HIGH',
  });

  // VIP / High value -> HIGH_VALUE_LEAD (HIGH)
  assert.deepEqual(classifyHandoverReason('khách hàng VIP dự án lớn'), {
    reason: 'HIGH_VALUE_LEAD',
    priority: 'HIGH',
  });

  // Price -> PRICE_QUOTATION_REQUIRED (NORMAL)
  assert.deepEqual(classifyHandoverReason('cần báo giá chi tiết theo m2'), {
    reason: 'PRICE_QUOTATION_REQUIRED',
    priority: 'NORMAL',
  });

  // Human request -> CUSTOMER_REQUESTED_HUMAN (NORMAL)
  assert.deepEqual(classifyHandoverReason('muốn gặp nhân viên tư vấn trực tiếp'), {
    reason: 'CUSTOMER_REQUESTED_HUMAN',
    priority: 'NORMAL',
  });
  assert.deepEqual(classifyHandoverReason('HUMAN_SUPPORT_REQUIRED'), {
    reason: 'CUSTOMER_REQUESTED_HUMAN',
    priority: 'NORMAL',
  });
  assert.deepEqual(classifyHandoverReason('CONVERSATION_STATE_HANDOVER_REQUIRED'), {
    reason: 'CUSTOMER_REQUESTED_HUMAN',
    priority: 'NORMAL',
  });

  // Knowledge / Confidence gaps -> NORMAL
  assert.deepEqual(classifyHandoverReason('thieu_thong_tin_san_pham'), {
    reason: 'INSUFFICIENT_KNOWLEDGE',
    priority: 'NORMAL',
  });
  assert.deepEqual(classifyHandoverReason('low_confidence_score'), {
    reason: 'LOW_CONFIDENCE',
    priority: 'NORMAL',
  });
});

test('Handover Classifier: falls closed to OTHER / LOW for null, undefined, empty, or unknown strings', () => {
  assert.deepEqual(classifyHandoverReason(null), {
    reason: 'OTHER',
    priority: 'LOW',
  });
  assert.deepEqual(classifyHandoverReason(undefined), {
    reason: 'OTHER',
    priority: 'LOW',
  });
  assert.deepEqual(classifyHandoverReason(''), {
    reason: 'OTHER',
    priority: 'LOW',
  });
  assert.deepEqual(classifyHandoverReason('   '), {
    reason: 'OTHER',
    priority: 'LOW',
  });
  assert.deepEqual(classifyHandoverReason('some_completely_unrecognized_custom_token'), {
    reason: 'OTHER',
    priority: 'LOW',
  });
});

test('Handover Classifier: respects priorityOverride option when provided', () => {
  const result = classifyHandoverReason('cần báo giá chi tiết', {
    priorityOverride: 'URGENT',
  });
  assert.equal(result.reason, 'PRICE_QUOTATION_REQUIRED');
  assert.equal(result.priority, 'URGENT');
});
