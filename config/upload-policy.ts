/**
 * Canonical Upload Policy & Transport Limits
 *
 * Defines the single authoritative source of truth for:
 * 1. Business-level product upload allowance (10 MiB max)
 * 2. Next.js transport envelope & proxy buffering (12 MiB max)
 *
 * Transport envelope is intentionally larger than product allowance to provide
 * sufficient headroom for multipart/FormData boundaries, headers, and metadata.
 */

/**
 * Canonical product-level upload maximum: 10 MiB (10,485,760 bytes).
 * Business workflows (Survey photos, Installation evidence, Contract documents)
 * permit files up to this limit.
 */
export const PRODUCT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Next.js transport-level envelope maximum: 12 MiB (12,582,912 bytes).
 * The transport envelope must be larger than the product file limit because
 * multipart/FormData adds field boundaries, Content-Disposition headers,
 * and MIME metadata overhead.
 *
 * Configured in next.config.ts for:
 * 1. experimental.serverActions.bodySizeLimit
 * 2. experimental.proxyClientMaxBodySize
 */
export const NEXT_UPLOAD_TRANSPORT_MAX_BYTES = 12 * 1024 * 1024; // 12 MiB

/**
 * Next.js string format for SizeLimit configuration.
 */
export const NEXT_UPLOAD_TRANSPORT_SIZE_LIMIT = '12mb' as const;

/**
 * Explicit multipart/FormData transport headroom in bytes (2 MiB = 2,097,152 bytes).
 */
export const UPLOAD_TRANSPORT_HEADROOM_BYTES =
  NEXT_UPLOAD_TRANSPORT_MAX_BYTES - PRODUCT_UPLOAD_MAX_BYTES;

/**
 * Pure parser converting size limit values (bytes number or unit strings like '12mb', '10MB')
 * into canonical byte counts. Avoids external compilation dependencies.
 */
export function parseSizeLimitToBytes(limit: number | string): number {
  if (typeof limit === 'number') return limit;
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(limit.trim());
  if (!match) throw new Error(`Invalid size limit string: ${limit}`);
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    k: 1024,
    mb: 1024 * 1024,
    m: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  const mult = multipliers[unit];
  if (!mult) throw new Error(`Unsupported size limit unit: ${unit}`);
  return Math.round(num * mult);
}

