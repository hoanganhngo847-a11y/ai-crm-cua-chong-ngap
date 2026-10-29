import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '@/lib/auth/context';
import { assertZaloAccountAdmin, listZaloAccounts, saveZaloAccount, toggleZaloAccount } from '@/features/omnichannel/zalo/accounts/service';
import { ZaloAccountInputError } from '@/features/omnichannel/zalo/accounts/credentials';
import { isZaloAccountOriginAllowed } from '@/features/omnichannel/zalo/accounts/origin';

export const runtime = 'nodejs';
const headers = { 'cache-control': 'no-store' };
function failure(error: unknown) {
  if (error instanceof ZaloAccountInputError) return NextResponse.json({ success: false, message: error.message }, { status: 400, headers });
  if (error instanceof Error && error.message === 'ZALO_ACCOUNT_ADMIN_REQUIRED') return NextResponse.json({ success: false, message: 'Chỉ quản trị viên đã xác thực hai bước mới được quản lý tài khoản Zalo.' }, { status: 403, headers });
  // Never log payloads, provider errors, or credentials.
  return NextResponse.json({ success: false, message: 'Chưa hoàn tất thao tác. Vui lòng thử lại; thông tin đăng nhập không được hiển thị lại.' }, { status: 503, headers });
}
export async function GET() {
  try {
    const actor = await getActorContext(); assertZaloAccountAdmin(actor);
    const accounts = await listZaloAccounts(actor.companyId);
    let legacyConnected = false;
    try {
      const response = await fetch(`${(process.env.ZALO_ZCAJS_WORKER_URL || '').replace(/\/$/, '')}/ready`, { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      legacyConnected = response.ok && (await response.json()).ready === true;
    } catch { /* A failed readiness check must never show an account as connected. */ }
    return NextResponse.json({ success: true, accounts, legacyConnected }, { headers });
  } catch (error) { return failure(error); }
}
async function mutate(request: NextRequest) {
  try {
    const actor = await getActorContext(); assertZaloAccountAdmin(actor);
    if (!isZaloAccountOriginAllowed(request)) return NextResponse.json({ success: false, message: 'Nguồn yêu cầu không hợp lệ.' }, { status: 403, headers });
    if (Number(request.headers.get('content-length') || '0') > 192 * 1024) return NextResponse.json({ success: false, message: 'File quá lớn.' }, { status: 413, headers });
    const text = await request.text();
    if (Buffer.byteLength(text) > 192 * 1024) throw new ZaloAccountInputError('File quá lớn. Hãy dùng JSON cookie dưới 128 KB.');
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { throw new ZaloAccountInputError('Dữ liệu gửi lên chưa hợp lệ.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ZaloAccountInputError('Dữ liệu gửi lên chưa hợp lệ.');
    if (request.method === 'PATCH') {
      if (typeof body.enabled !== 'boolean') throw new ZaloAccountInputError('Trạng thái chưa hợp lệ.');
      await toggleZaloAccount(actor, String(body.id || ''), body.enabled);
    } else await saveZaloAccount(actor, body);
    return NextResponse.json({ success: true, message: 'Đã lưu. Hệ thống sẽ kiểm tra và cập nhật trạng thái kết nối tự động.' }, { headers });
  } catch (error) { return failure(error); }
}
export const POST = mutate;
export const PATCH = mutate;
