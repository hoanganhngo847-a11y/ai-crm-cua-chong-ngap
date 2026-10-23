import { timingSafeEqual } from 'node:crypto';
import { processDossierRefresh } from '../../../../features/customer-360/worker';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: 'UNAVAILABLE' }, { status: 503 });
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '')?.[1] || '';
  if (Buffer.byteLength(token) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(token), Buffer.from(secret))) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  if ([...new URL(request.url).searchParams].length) return Response.json({ error: 'INVALID_QUERY' }, { status: 400 });
  try { return Response.json(await processDossierRefresh()); }
  catch { return Response.json({ error: 'WORKER_FAILED' }, { status: 503 }); }
}
