import 'server-only';

import type { BrainCustomerMemoryContext } from '../context-contracts';

const PASSWORD_PATTERN = /\b(?:password|mật\s*khẩu|mat\s*khau|pwd)\b/i;
const OTP_PATTERN = /\b(?:otp|mã\s*xác\s*thực|mã\s*xác\s*nhận|verification\s*code)\b/i;
const TOKEN_PATTERN = /(?:bearer\s+[A-Za-z0-9._~+/-]{20,}|(?:sk|ghp|xoxb|xoxp)-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/i;
const CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b|\b\d{15,16}\b/;

export interface MemorySanitizationResult {
  readonly safe: boolean;
  readonly reason?: 'PASSWORD_DETECTED' | 'OTP_DETECTED' | 'TOKEN_DETECTED' | 'CARD_DETECTED' | 'INVALID_INFERENCE_CONFIRMATION' | 'CONTENT_EMPTY' | 'CONTENT_TOO_LONG';
}

/**
 * Validates a customer memory record against strict data privacy policies.
 * Never allows credentials, OTPs, payment card numbers, or raw auth tokens to be stored or retrieved.
 */
export function sanitizeCustomerMemory(
  memory: Pick<BrainCustomerMemoryContext, 'content' | 'memoryType' | 'verificationStatus'>
): MemorySanitizationResult {
  const content = (memory.content || '').trim();
  if (!content) {
    return { safe: false, reason: 'CONTENT_EMPTY' };
  }
  if (content.length > 4000) {
    return { safe: false, reason: 'CONTENT_TOO_LONG' };
  }

  // 1. Password detection
  if (PASSWORD_PATTERN.test(content)) {
    return { safe: false, reason: 'PASSWORD_DETECTED' };
  }

  // 2. OTP detection
  if (OTP_PATTERN.test(content)) {
    return { safe: false, reason: 'OTP_DETECTED' };
  }

  // 3. Token / API key detection
  if (TOKEN_PATTERN.test(content)) {
    return { safe: false, reason: 'TOKEN_DETECTED' };
  }

  // 4. Payment card number detection
  if (CARD_PATTERN.test(content)) {
    return { safe: false, reason: 'CARD_DETECTED' };
  }

  // 5. Invariant: AI_INFERENCE cannot be CONFIRMED
  if (memory.memoryType === 'AI_INFERENCE' && memory.verificationStatus === 'CONFIRMED') {
    return { safe: false, reason: 'INVALID_INFERENCE_CONFIRMATION' };
  }

  return { safe: true };
}
