import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeCustomerMemory } from '../../features/ai-brain/memory/sanitizer';

test('Memory Sanitizer: approves safe customer preferences and requirements', () => {
  const result = sanitizeCustomerMemory({
    content: 'Khách hàng quan tâm đến máy ép Hurom H400 màu xám, thích giao hàng buổi sáng.',
    memoryType: 'PREFERENCE',
    verificationStatus: 'CONFIRMED',
  });
  assert.equal(result.safe, true);
  assert.equal(result.reason, undefined);
});

test('Memory Sanitizer: rejects password leaks', () => {
  const result = sanitizeCustomerMemory({
    content: 'Mật khẩu wifi của khách: SecretPass123',
    memoryType: 'FACT',
    verificationStatus: 'UNVERIFIED',
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'PASSWORD_DETECTED');
});

test('Memory Sanitizer: rejects OTP leaks', () => {
  const result = sanitizeCustomerMemory({
    content: 'Mã xác thực OTP: 839201',
    memoryType: 'TEMPORARY_CONTEXT',
    verificationStatus: 'UNVERIFIED',
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'OTP_DETECTED');
});

test('Memory Sanitizer: rejects Bearer and API token leaks', () => {
  const result = sanitizeCustomerMemory({
    content: 'Token xác thực hệ thống: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisTokenValue123',
    memoryType: 'FACT',
    verificationStatus: 'UNVERIFIED',
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'TOKEN_DETECTED');
});

test('Memory Sanitizer: rejects payment credit card numbers', () => {
  const result = sanitizeCustomerMemory({
    content: 'Số thẻ thanh toán: 4111 2222 3333 4444',
    memoryType: 'FACT',
    verificationStatus: 'UNVERIFIED',
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'CARD_DETECTED');
});

test('Memory Sanitizer: prevents AI_INFERENCE from being CONFIRMED', () => {
  const result = sanitizeCustomerMemory({
    content: 'Khách hàng có khả năng mua đơn hàng lớn trên 50 triệu',
    memoryType: 'AI_INFERENCE',
    verificationStatus: 'CONFIRMED',
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'INVALID_INFERENCE_CONFIRMATION');
});

test('Memory Sanitizer: approves AI_INFERENCE when UNVERIFIED', () => {
  const result = sanitizeCustomerMemory({
    content: 'Khách hàng có khả năng mua đơn hàng lớn trên 50 triệu',
    memoryType: 'AI_INFERENCE',
    verificationStatus: 'UNVERIFIED',
  });
  assert.equal(result.safe, true);
});

test('Memory Sanitizer: rejects empty content', () => {
  const result = sanitizeCustomerMemory({
    content: '   ',
    memoryType: 'FACT',
    verificationStatus: 'UNVERIFIED',
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, 'CONTENT_EMPTY');
});
