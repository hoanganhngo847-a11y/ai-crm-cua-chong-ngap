import crypto from 'crypto';

export interface VerifyWebhookParams {
  rawBody: string;
  timestamp: string | number;
  signature: string;
  appId: string;
  appSecret: string;
}

/**
 * Verifies the Zalo OA webhook signature (mac).
 * Zalo OA signs webhooks using SHA256:
 * mac = sha256(app_id + raw_body + timestamp + app_secret)
 *
 * Uses crypto.timingSafeEqual to defend against timing attacks.
 */
export function verifyZaloWebhookSignature({
  rawBody,
  timestamp,
  signature,
  appId,
  appSecret,
}: VerifyWebhookParams): boolean {
  if (!signature || !appSecret) {
    return false;
  }

  // Clean signature (remove 'mac=' prefix if present)
  let cleanSignature = signature.trim();
  if (cleanSignature.toLowerCase().startsWith('mac=')) {
    cleanSignature = cleanSignature.substring(4).trim();
  }

  // Zalo MAC string construction: sha256(appId + rawBody + timestamp + appSecret)
  const dataToSign = `${appId}${rawBody}${timestamp}${appSecret}`;
  const expectedHash = crypto.createHash('sha256').update(dataToSign, 'utf8').digest('hex');

  const sigBuffer = Buffer.from(cleanSignature.toLowerCase(), 'utf8');
  const expectedBuffer = Buffer.from(expectedHash.toLowerCase(), 'utf8');

  if (sigBuffer.length !== expectedBuffer.length) {
    // Alternative check: sha256(data + timestamp + appSecret) without appId
    const fallbackDataToSign = `${rawBody}${timestamp}${appSecret}`;
    const fallbackExpectedHash = crypto.createHash('sha256').update(fallbackDataToSign, 'utf8').digest('hex');
    const fallbackBuffer = Buffer.from(fallbackExpectedHash.toLowerCase(), 'utf8');

    if (sigBuffer.length === fallbackBuffer.length) {
      return crypto.timingSafeEqual(sigBuffer, fallbackBuffer);
    }
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}
