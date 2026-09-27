/**
 * Message Sanitizer for Central Inbox & Omnichannel Ingress.
 * Enforces the Zero-Phone invariant: Customers may enter raw phone numbers in chat messages,
 * but these MUST be sanitized before storing in public.interactions.sanitized_content.
 *
 * Role SALE is strictly prohibited from seeing unmasked phone numbers.
 * Raw contents are preserved in the private security zone (private.interaction_raw_contents).
 */

export interface SanitizeResult {
  sanitizedText: string;
  hasSensitiveData: boolean;
  detectedCount: number;
}

/**
 * Regex matching standard Vietnamese mobile and landline numbers:
 * - Prefixes: 03, 05, 07, 08, 09, +843, +845, +847, +848, +849
 * - Supports separators like space, dot, hyphen (e.g., 0912.345.678, 0912 345 678, 0912-345-678)
 */
const VIETNAMESE_PHONE_REGEX = /(?:\+84|0)(?:[\s.-]*\d){9,10}\b/g;

/**
 * Sanitizes message text by masking any detected phone numbers.
 * Example: "0912345678" -> "0912***678"
 */
export function sanitizeMessageContent(rawText: string): SanitizeResult {
  if (!rawText || !rawText.trim()) {
    return {
      sanitizedText: rawText || '',
      hasSensitiveData: false,
      detectedCount: 0,
    };
  }

  let count = 0;
  const sanitizedText = rawText.replace(VIETNAMESE_PHONE_REGEX, (match) => {
    count++;
    const digitsOnly = match.replace(/[\s.-]/g, '');
    if (digitsOnly.length >= 10) {
      const prefix = digitsOnly.slice(0, 4);
      const suffix = digitsOnly.slice(-3);
      return `${prefix}***${suffix}`;
    }
    return '[SỐ ĐIỆN THOẠI ĐÃ ĐƯỢC BẢO VỆ]';
  });

  return {
    sanitizedText,
    hasSensitiveData: count > 0,
    detectedCount: count,
  };
}
