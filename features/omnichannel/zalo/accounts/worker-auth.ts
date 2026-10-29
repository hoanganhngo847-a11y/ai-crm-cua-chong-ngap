import 'server-only';
import { timingSafeEqual } from 'node:crypto';

export function authorizeZaloWorker(request: Request) {
  const secret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';
  const supplied = request.headers.get('x-worker-secret') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  const companyId = process.env.ZALO_ZCAJS_COMPANY_ID || '';
  const expected = Buffer.from(secret); const actual = Buffer.from(supplied);
  if (!secret || !supplied || !companyId || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return companyId;
}
