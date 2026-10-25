import 'server-only';

const DEFAULT_ZCAJS_TIMEOUT_MS = 20_000;

function normalizeVietnamPhone(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let digits = String(value).trim().replace(/[\s().-]+/g, '');
  if (!digits || /[*xX]/.test(digits)) return null;
  digits = digits.replace(/^\+/, '');
  if (/^84[1-9][0-9]{7,12}$/.test(digits)) digits = `0${digits.slice(2)}`;
  return /^0[1-9][0-9]{7,12}$/.test(digits) ? digits : null;
}

function requireWorkerConfig(companyId: string) {
  const configuredCompanyId = (process.env.ZALO_ZCAJS_COMPANY_ID || '').trim();
  const workerUrl = (process.env.ZALO_ZCAJS_WORKER_URL || '').trim();
  const workerSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';

  if (!configuredCompanyId || !workerUrl || !workerSecret) {
    throw new Error('ZCAJS_PHONE_RESOLVER_NOT_CONFIGURED');
  }
  if (configuredCompanyId !== companyId) throw new Error('ZCAJS_PHONE_COMPANY_MISMATCH');

  let parsed: URL;
  try {
    parsed = new URL(workerUrl);
  } catch {
    throw new Error('ZCAJS_PHONE_WORKER_URL_INVALID');
  }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('ZCAJS_PHONE_WORKER_URL_INSECURE');
  }
  return { workerUrl: parsed, workerSecret };
}

export async function resolveZcaJsPhone(
  companyId: string,
  userId: string,
  options: { fetchFn?: typeof fetch } = {}
): Promise<string | null> {
  if (!/^[0-9]{5,40}$/.test(userId)) return null;
  const { workerUrl, workerSecret } = requireWorkerConfig(companyId);
  const fetchFn = options.fetchFn || fetch;

  const response = await fetchFn(new URL('/v1/resolve-phone', workerUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${workerSecret}`,
    },
    body: JSON.stringify({ companyId, userId }),
    signal: AbortSignal.timeout(DEFAULT_ZCAJS_TIMEOUT_MS),
    cache: 'no-store',
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ZCAJS_PHONE_RESOLVER_HTTP_${response.status}`);

  const body = (await response.json().catch(() => null)) as
    | { success?: unknown; phone?: unknown }
    | null;
  if (!body || body.success !== true) throw new Error('ZCAJS_PHONE_RESOLVER_INVALID_RESPONSE');
  return normalizeVietnamPhone(body.phone);
}
