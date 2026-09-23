import {
  EMOJI_USAGES,
  PREFERRED_LENGTHS,
  type ClosingStyle,
  type EmojiUsage,
  type ObjectionApproach,
  type ObjectionStyle,
  type PreferredLength,
  type QuestionStyle,
  type SalutationRules,
  type SalesStyleOutput,
  type SentenceStyle,
} from '@/shared/contracts/sales-style';

export class SalesStyleValidationError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'SalesStyleValidationError';
  }
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'salutationRules',
  'sentenceStyle',
  'questionStyle',
  'objectionStyle',
  'closingStyle',
]);

interface BusinessPolicyPattern {
  pattern: RegExp;
  reason: string;
}

export const BUSINESS_POLICY_PATTERNS: BusinessPolicyPattern[] = [
  { pattern: /giảm\s*giá/iu, reason: 'discount reference (giảm giá)' },
  { pattern: /chiết\s*khấu/iu, reason: 'discount reference (chiết khấu)' },
  { pattern: /(?<=^|[^\p{L}\p{N}])discount(?=[^\p{L}\p{N}]|$)/iu, reason: 'discount reference (discount)' },
  { pattern: /khuyến\s*m[aã]i/iu, reason: 'promotion reference (khuyến mãi)' },
  { pattern: /%|(?<=^|[^\p{L}\p{N}])(?:percent|phần\s*trăm)(?=[^\p{L}\p{N}]|$)/iu, reason: 'percentage indicator (%/percent)' },
  { pattern: /giá\s*bán|mức\s*giá|báo\s*giá|bảng\s*giá|đơn\s*giá/iu, reason: 'price quote reference' },
  { pattern: /(?<=^|[^\p{L}\p{N}])(?:vnđ|vnd)(?=[^\p{L}\p{N}]|$)|₫/iu, reason: 'currency indicator (VND/₫)' },
  {
    pattern: /(?<=^|[^\p{L}\p{N}])\d+(?:[\.,]\d{3})*(?:\s*(?:triệu|nghìn|ngàn|tr|k|đồng)\b|\s*[đ₫])/iu,
    reason: 'monetary amount detected',
  },
  { pattern: /đặt\s*cọc|tiền\s*cọc|(?<=^|[^\p{L}\p{N}])cọc(?=[^\p{L}\p{N}]|$)/iu, reason: 'deposit reference (cọc)' },
  {
    pattern: /payment\s*terms|(?<=^|[^\p{L}\p{N}])(?:thanh\s*toán|payment|chuyển\s*khoản|trả\s*góp)(?=[^\p{L}\p{N}]|$)/iu,
    reason: 'payment terms reference',
  },
  { pattern: /hợp\s*đồng|(?<=^|[^\p{L}\p{N}])contract(?=[^\p{L}\p{N}]|$)/iu, reason: 'contract policy reference' },
  { pattern: /bảo\s*hành|(?<=^|[^\p{L}\p{N}])warranty(?=[^\p{L}\p{N}]|$)/iu, reason: 'warranty commitment reference' },
  { pattern: /(?<=^|[^\p{L}\p{N}])phí(?=[^\p{L}\p{N}]|$)|lãi\s*suất/iu, reason: 'fees/interest rate reference' },
  {
    pattern: /cam\s*kết\s*(?:giao\s*hàng|bảo\s*hành|tiến\s*độ|giá|doanh\s*nghiệp|chất\s*lượng|hoàn\s*tiền)/iu,
    reason: 'enterprise commitment reference',
  },
];

/**
 * Asserts that a style string contains no business policies, pricing terms, discounts,
 * payment terms, deposit rules, warranty promises, or enterprise commitments.
 * Fails closed on any detected pattern.
 */
export function assertStyleTextContainsNoBusinessPolicy(text: string, path: string): void {
  for (const { pattern, reason } of BUSINESS_POLICY_PATTERNS) {
    if (pattern.test(text)) {
      throw new SalesStyleValidationError(
        `Business policy violation detected in "${path}": forbidden ${reason} found in "${text}"`,
        { path, reason, text }
      );
    }
  }
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  contextName: string
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new SalesStyleValidationError(
        `Unexpected or forbidden field "${key}" in ${contextName}`,
        { field: key, context: contextName }
      );
    }
  }
}

function validateStringArray(
  val: unknown,
  fieldName: string,
  minItems: number,
  maxItems: number,
  maxCharsPerItem: number
): string[] {
  if (!Array.isArray(val)) {
    throw new SalesStyleValidationError(`${fieldName} must be an array of strings`, { field: fieldName });
  }
  if (val.length < minItems) {
    throw new SalesStyleValidationError(
      `${fieldName} requires at least ${minItems} item(s), got ${val.length}`,
      { field: fieldName }
    );
  }
  if (val.length > maxItems) {
    throw new SalesStyleValidationError(
      `${fieldName} exceeds maximum allowed count of ${maxItems} items`,
      { field: fieldName }
    );
  }

  const result: string[] = [];
  for (let i = 0; i < val.length; i++) {
    const item = val[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new SalesStyleValidationError(
        `${fieldName}[${i}] must be a non-empty string`,
        { field: fieldName, index: i }
      );
    }
    const trimmed = item.trim();
    if (trimmed.length > maxCharsPerItem) {
      throw new SalesStyleValidationError(
        `${fieldName}[${i}] exceeds maximum length of ${maxCharsPerItem} characters`,
        { field: fieldName, index: i, length: trimmed.length }
      );
    }
    // Enforce business policy content firewall on every string item
    assertStyleTextContainsNoBusinessPolicy(trimmed, `${fieldName}[${i}]`);
    result.push(trimmed);
  }
  return result;
}

function validateSalutationRules(raw: unknown): SalutationRules {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SalesStyleValidationError('salutationRules must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['selfReferences', 'customerReferences', 'commonOpenings', 'notes']);
  assertExactKeys(obj, allowed, 'salutationRules');

  return {
    selfReferences: validateStringArray(obj.selfReferences, 'salutationRules.selfReferences', 1, 10, 100),
    customerReferences: validateStringArray(obj.customerReferences, 'salutationRules.customerReferences', 1, 10, 100),
    commonOpenings: validateStringArray(obj.commonOpenings ?? [], 'salutationRules.commonOpenings', 0, 10, 300),
    notes: validateStringArray(obj.notes ?? [], 'salutationRules.notes', 0, 10, 500),
  };
}

function validateSentenceStyle(raw: unknown): SentenceStyle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SalesStyleValidationError('sentenceStyle must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    'preferredLength',
    'toneDescriptors',
    'emojiUsage',
    'punctuationPatterns',
    'notes',
  ]);
  assertExactKeys(obj, allowed, 'sentenceStyle');

  if (typeof obj.preferredLength !== 'string' || !PREFERRED_LENGTHS.includes(obj.preferredLength as PreferredLength)) {
    throw new SalesStyleValidationError(
      `sentenceStyle.preferredLength must be one of: ${PREFERRED_LENGTHS.join(', ')}`,
      { field: 'sentenceStyle.preferredLength', value: obj.preferredLength }
    );
  }

  if (typeof obj.emojiUsage !== 'string' || !EMOJI_USAGES.includes(obj.emojiUsage as EmojiUsage)) {
    throw new SalesStyleValidationError(
      `sentenceStyle.emojiUsage must be one of: ${EMOJI_USAGES.join(', ')}`,
      { field: 'sentenceStyle.emojiUsage', value: obj.emojiUsage }
    );
  }

  return {
    preferredLength: obj.preferredLength as PreferredLength,
    toneDescriptors: validateStringArray(obj.toneDescriptors, 'sentenceStyle.toneDescriptors', 1, 10, 100),
    emojiUsage: obj.emojiUsage as EmojiUsage,
    punctuationPatterns: validateStringArray(obj.punctuationPatterns ?? [], 'sentenceStyle.punctuationPatterns', 0, 10, 100),
    notes: validateStringArray(obj.notes ?? [], 'sentenceStyle.notes', 0, 10, 500),
  };
}

function validateQuestionStyle(raw: unknown): QuestionStyle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SalesStyleValidationError('questionStyle must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['commonPatterns', 'discoveryApproach', 'followUpApproach', 'notes']);
  assertExactKeys(obj, allowed, 'questionStyle');

  return {
    commonPatterns: validateStringArray(obj.commonPatterns ?? [], 'questionStyle.commonPatterns', 0, 10, 300),
    discoveryApproach: validateStringArray(obj.discoveryApproach ?? [], 'questionStyle.discoveryApproach', 0, 10, 300),
    followUpApproach: validateStringArray(obj.followUpApproach ?? [], 'questionStyle.followUpApproach', 0, 10, 300),
    notes: validateStringArray(obj.notes ?? [], 'questionStyle.notes', 0, 10, 500),
  };
}

function validateObjectionStyle(raw: unknown): ObjectionStyle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SalesStyleValidationError('objectionStyle must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['approaches', 'notes']);
  assertExactKeys(obj, allowed, 'objectionStyle');

  if (!Array.isArray(obj.approaches)) {
    throw new SalesStyleValidationError('objectionStyle.approaches must be an array');
  }
  if (obj.approaches.length > 10) {
    throw new SalesStyleValidationError('objectionStyle.approaches exceeds maximum allowed count of 10');
  }

  const approachesAllowed = new Set(['situation', 'responseApproach']);
  const approaches: ObjectionApproach[] = [];
  for (let i = 0; i < obj.approaches.length; i++) {
    const item = obj.approaches[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SalesStyleValidationError(`objectionStyle.approaches[${i}] must be an object`);
    }
    const approachObj = item as Record<string, unknown>;
    assertExactKeys(approachObj, approachesAllowed, `objectionStyle.approaches[${i}]`);

    if (typeof approachObj.situation !== 'string' || approachObj.situation.trim().length === 0) {
      throw new SalesStyleValidationError(`objectionStyle.approaches[${i}].situation must be a non-empty string`);
    }
    const situation = approachObj.situation.trim();
    if (situation.length > 300) {
      throw new SalesStyleValidationError(
        `objectionStyle.approaches[${i}].situation exceeds maximum length of 300 characters`
      );
    }

    if (typeof approachObj.responseApproach !== 'string' || approachObj.responseApproach.trim().length === 0) {
      throw new SalesStyleValidationError(`objectionStyle.approaches[${i}].responseApproach must be a non-empty string`);
    }
    const responseApproach = approachObj.responseApproach.trim();
    if (responseApproach.length > 500) {
      throw new SalesStyleValidationError(
        `objectionStyle.approaches[${i}].responseApproach exceeds maximum length of 500 characters`
      );
    }

    assertStyleTextContainsNoBusinessPolicy(situation, `objectionStyle.approaches[${i}].situation`);
    assertStyleTextContainsNoBusinessPolicy(responseApproach, `objectionStyle.approaches[${i}].responseApproach`);

    approaches.push({ situation, responseApproach });
  }

  return {
    approaches,
    notes: validateStringArray(obj.notes ?? [], 'objectionStyle.notes', 0, 10, 500),
  };
}

function validateClosingStyle(raw: unknown): ClosingStyle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SalesStyleValidationError('closingStyle must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set(['commonClosings', 'callToActionPatterns', 'urgencyStyle', 'notes']);
  assertExactKeys(obj, allowed, 'closingStyle');

  return {
    commonClosings: validateStringArray(obj.commonClosings ?? [], 'closingStyle.commonClosings', 0, 10, 300),
    callToActionPatterns: validateStringArray(obj.callToActionPatterns ?? [], 'closingStyle.callToActionPatterns', 0, 10, 300),
    urgencyStyle: validateStringArray(obj.urgencyStyle ?? [], 'closingStyle.urgencyStyle', 0, 10, 300),
    notes: validateStringArray(obj.notes ?? [], 'closingStyle.notes', 0, 10, 500),
  };
}

/**
 * Strict fail-closed validator for untrusted Sales Style LLM output.
 * Guarantees adherence to canonical style schema while enforcing the Project Master business policy firewall.
 *
 * REJECTS:
 * - Non-object or malformed shapes
 * - Any unknown top-level key (e.g. priceRule, discountRule, authority, modelVersion, version)
 * - Any oversized string or array
 * - Invalid enum values
 */
export function validateSalesStyleOutput(raw: unknown): SalesStyleOutput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SalesStyleValidationError('Sales style output must be a non-null JSON object');
  }

  const record = raw as Record<string, unknown>;

  // Strict firewall against unknown keys and business policy injections
  assertExactKeys(record, ALLOWED_TOP_LEVEL_KEYS, 'top-level sales style output');

  // Verify all 5 required style sections are present
  if (!('salutationRules' in record)) {
    throw new SalesStyleValidationError('Missing required field: salutationRules');
  }
  if (!('sentenceStyle' in record)) {
    throw new SalesStyleValidationError('Missing required field: sentenceStyle');
  }
  if (!('questionStyle' in record)) {
    throw new SalesStyleValidationError('Missing required field: questionStyle');
  }
  if (!('objectionStyle' in record)) {
    throw new SalesStyleValidationError('Missing required field: objectionStyle');
  }
  if (!('closingStyle' in record)) {
    throw new SalesStyleValidationError('Missing required field: closingStyle');
  }

  return {
    salutationRules: validateSalutationRules(record.salutationRules),
    sentenceStyle: validateSentenceStyle(record.sentenceStyle),
    questionStyle: validateQuestionStyle(record.questionStyle),
    objectionStyle: validateObjectionStyle(record.objectionStyle),
    closingStyle: validateClosingStyle(record.closingStyle),
  };
}
