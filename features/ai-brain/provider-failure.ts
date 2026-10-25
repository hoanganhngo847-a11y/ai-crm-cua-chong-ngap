import 'server-only';

export const PROVIDER_FAILURE_CODES = [
  'BRAIN_TIMEOUT', 'BRAIN_CONFIG_MISSING', 'BRAIN_AUTH_FAILED', 'BRAIN_HTTP_ERROR', 'BRAIN_REQUEST_INVALID', 'RUNTIME_REQUEST_INVALID',
  'RUNTIME_AUTH_FAILED', 'RUNTIME_HTTP_ERROR', 'MODEL_PROVIDER_ERROR',
  'MODEL_RATE_LIMIT', 'MODEL_TIMEOUT', 'MODEL_CONFIG_INVALID',
] as const;
export type ProviderFailureCode = typeof PROVIDER_FAILURE_CODES[number];
export type ProviderPhase = 'JAVIS_BRAIN' | 'JAVIS_RUNTIME' | 'MODEL_PROVIDER';
export interface ProviderDiagnostic {
  readonly code: ProviderFailureCode;
  readonly phase: ProviderPhase;
  readonly httpStatus?: number;
  readonly retryable: boolean;
}

// Only errors minted at our adapters carry diagnostics; arbitrary thrown objects,
// messages and forged prototypes cannot select a persisted error code.
const diagnostics = new WeakMap<object, Readonly<ProviderDiagnostic>>();
export class ProviderFailure extends Error {
  constructor(code: ProviderFailureCode, phase: ProviderPhase, httpStatus?: number) {
    super(PROVIDER_FAILURE_CODES.includes(code) ? code : 'BRAIN_PROVIDER_ERROR');
    if (!PROVIDER_FAILURE_CODES.includes(code) ||
        !['JAVIS_BRAIN', 'JAVIS_RUNTIME', 'MODEL_PROVIDER'].includes(phase) ||
        (httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))) {
      return;
    }
    const retryable = !['BRAIN_CONFIG_MISSING', 'BRAIN_AUTH_FAILED', 'RUNTIME_AUTH_FAILED',
      'MODEL_CONFIG_INVALID', 'BRAIN_REQUEST_INVALID', 'RUNTIME_REQUEST_INVALID'].includes(code) &&
      (httpStatus === undefined || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500);
    diagnostics.set(this, Object.freeze({ code, phase, httpStatus, retryable }));
  }
}
export function providerDiagnostic(error: unknown): Readonly<ProviderDiagnostic> | undefined {
  return error !== null && typeof error === 'object' ? diagnostics.get(error) : undefined;
}
export function httpProviderFailure(phase: 'JAVIS_BRAIN' | 'JAVIS_RUNTIME', status: number): ProviderFailure {
  if (phase === 'JAVIS_BRAIN' && [408, 504].includes(status)) return new ProviderFailure('BRAIN_TIMEOUT', phase, status);
  return new ProviderFailure(status === 401 || status === 403
    ? (phase === 'JAVIS_BRAIN' ? 'BRAIN_AUTH_FAILED' : 'RUNTIME_AUTH_FAILED')
    : status >= 400 && status < 500 && ![408, 429].includes(status)
      ? (phase === 'JAVIS_BRAIN' ? 'BRAIN_REQUEST_INVALID' : 'RUNTIME_REQUEST_INVALID')
      : (phase === 'JAVIS_BRAIN' ? 'BRAIN_HTTP_ERROR' : 'RUNTIME_HTTP_ERROR'), phase, status);
}

export function diagnosticFromHeaders(headers: Headers): ProviderFailure | undefined {
  const code = headers.get('x-ai-brain-error');
  const phase = headers.get('x-ai-brain-phase');
  const rawStatus = headers.get('x-ai-brain-upstream-status');
  if (!PROVIDER_FAILURE_CODES.includes(code as ProviderFailureCode) ||
      !['JAVIS_BRAIN', 'JAVIS_RUNTIME', 'MODEL_PROVIDER'].includes(phase ?? '')) return;
  const status = rawStatus && /^[1-5]\d\d$/.test(rawStatus) ? Number(rawStatus) : undefined;
  return new ProviderFailure(code as ProviderFailureCode, phase as ProviderPhase, status);
}
