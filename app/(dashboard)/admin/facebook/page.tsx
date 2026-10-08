import Link from 'next/link';

import { getActorContext } from '@/lib/auth/context';
import {
  getConfiguredFacebookConnection,
  readFacebookConnectSession,
} from '@/features/omnichannel/facebook/connect';

const ERROR_MESSAGES: Record<string, string> = {
  NO_COMPANY: 'Không xác định được doanh nghiệp hiện tại.',
  MFA_REQUIRED: 'Cần xác thực MFA/AAL2 trước khi kết nối Facebook.',
  FACEBOOK_AUTH_CANCELLED: 'Bạn đã hủy bước đăng nhập Facebook.',
  FACEBOOK_INVALID_STATE: 'Phiên kết nối Facebook không hợp lệ. Vui lòng thử lại.',
  FACEBOOK_MISSING_CODE: 'Facebook không trả về mã xác thực.',
  FACEBOOK_TOKEN_EXCHANGE_FAILED: 'Không thể đổi mã xác thực lấy access token.',
  FACEBOOK_PAGE_LIST_FAILED: 'Không thể lấy danh sách Page mà tài khoản này quản lý.',
  FACEBOOK_CONNECT_CALLBACK_FAILED: 'Kết nối Facebook thất bại ở bước callback.',
  FACEBOOK_CONNECT_SESSION_EXPIRED: 'Phiên chọn Page đã hết hạn. Vui lòng kết nối lại.',
  FACEBOOK_PAGE_NOT_MANAGED: 'Tài khoản Facebook này không quản lý Page đã chọn.',
  FACEBOOK_PAGE_NOT_ALLOWED_FOR_WORKSPACE:
    'Page đã chọn chưa được cấu hình cho workspace CRM hiện tại.',
  FACEBOOK_SUBSCRIBE_FAILED: 'Không thể đăng ký Page với webhook Messenger.',
  FACEBOOK_CONNECT_SELECT_FAILED: 'Không thể hoàn tất kết nối Page.',
  FACEBOOK_CONNECT_START_FAILED: 'Không thể bắt đầu đăng nhập Facebook.',
};

function textParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function FacebookConnectionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const errorCode = textParam(params.error);
  const connected = textParam(params.connected) === '1';
  const connectedPageName = textParam(params.page);
  const actor = await getActorContext();
  const companyId = actor?.companyId || '';

  const [connection, session] = await Promise.all([
    getConfiguredFacebookConnection(companyId),
    readFacebookConnectSession(),
  ]);

  const configuredPageId = connection.pageId;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-blue-400">
            Meta Messenger Integration
          </p>
          <h1 className="mt-2 text-3xl font-bold text-white">
            Kết nối Facebook Page
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
            Boss Admin đăng nhập Facebook, xem các Page mình đang quản lý, chọn Page
            được phép của workspace và đăng ký Page đó với webhook Messenger của CRM.
          </p>
        </div>
        <Link
          href="/inbox"
          className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-200 hover:border-slate-600 hover:bg-slate-800"
        >
          Mở Hộp thư
        </Link>
      </div>

      {errorCode && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/40 p-4 text-sm text-red-200">
          <div className="font-semibold">Không thể hoàn tất kết nối</div>
          <div className="mt-1 text-red-300">
            {ERROR_MESSAGES[errorCode] || errorCode}
          </div>
        </div>
      )}

      {connected && (
        <div className="rounded-xl border border-emerald-700/60 bg-emerald-950/30 p-4 text-sm text-emerald-200">
          <div className="font-semibold">Kết nối thành công</div>
          <div className="mt-1 text-emerald-300">
            Page {connectedPageName ? `“${connectedPageName}”` : 'đã chọn'} đã được
            đăng ký với webhook Messenger của ứng dụng.
          </div>
        </div>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Bước 1
          </div>
          <h2 className="mt-2 text-lg font-semibold text-white">Đăng nhập Facebook</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Chỉ Boss Admin có AAL2 mới được bắt đầu luồng kết nối. CRM yêu cầu đúng các
            quyền pages_show_list, pages_manage_metadata và pages_messaging.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Bước 2
          </div>
          <h2 className="mt-2 text-lg font-semibold text-white">Chọn Page quản lý</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            CRM lấy danh sách Page từ Meta và chỉ cho phép chọn một Page thực sự nằm
            trong danh sách mà tài khoản Facebook đang quản lý.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Bước 3
          </div>
          <h2 className="mt-2 text-lg font-semibold text-white">Đăng ký webhook</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            CRM gọi Meta Graph API để subscribe trường messages cho Page đã chọn, sau
            đó Messenger có thể chuyển tin nhắn khách vào Hộp thư CRM.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Trạng thái Page hiện tại</h2>
            <p className="mt-1 text-sm text-slate-400">
              Thông tin này được kiểm tra trực tiếp từ cấu hình server và Meta Graph API.
            </p>
          </div>
          <div
            className={`inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-semibold ${
              connection.configured && connection.subscribed
                ? 'bg-emerald-500/15 text-emerald-300'
                : connection.configured
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-slate-800 text-slate-400'
            }`}
          >
            {connection.configured && connection.subscribed
              ? 'Đã kết nối webhook'
              : connection.configured
                ? 'Đã cấu hình · cần kiểm tra subscription'
                : 'Chưa cấu hình'}
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm md:grid-cols-2">
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="text-slate-500">Tên Page</div>
            <div className="mt-1 font-medium text-slate-100">
              {connection.pageName || 'Chưa lấy được tên Page'}
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="text-slate-500">Page ID được phép</div>
            <div className="mt-1 break-all font-mono text-slate-100">
              {configuredPageId || 'Chưa cấu hình'}
            </div>
          </div>
        </div>

        <div className="mt-5">
          <a
            href="/api/facebook/connect/start"
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
          >
            Kết nối / xác minh lại bằng Facebook
          </a>
          <p className="mt-2 text-xs text-slate-500">
            Access token dùng trong bước onboarding chỉ được giữ trong cookie HttpOnly mã
            hóa tối đa 10 phút và không được trả về trình duyệt dưới dạng dữ liệu hiển thị.
          </p>
        </div>
      </section>

      {session && session.companyId === companyId && (
        <section className="rounded-2xl border border-blue-800/60 bg-blue-950/20 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">
                Chọn Facebook Page để kết nối
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Meta trả về {session.pages.length} Page mà tài khoản vừa đăng nhập đang
                quản lý. Page có nhãn “Được phép” là Page của workspace hiện tại.
              </p>
            </div>
            <span className="rounded-full bg-blue-500/15 px-3 py-1 text-xs font-semibold text-blue-300">
              pages_show_list
            </span>
          </div>

          {session.pages.length === 0 ? (
            <div className="mt-5 rounded-xl border border-amber-800/50 bg-amber-950/30 p-4 text-sm text-amber-200">
              Facebook không trả về Page nào. Hãy kiểm tra tài khoản vừa đăng nhập có quyền
              quản lý Page hay không.
            </div>
          ) : (
            <div className="mt-5 grid gap-3">
              {session.pages.map((page) => {
                const allowed = page.id === configuredPageId;
                return (
                  <div
                    key={page.id}
                    className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-100">{page.name}</span>
                        {allowed && (
                          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                            Được phép cho workspace
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-xs text-slate-500">{page.id}</div>
                    </div>
                    <form action="/api/facebook/connect/select" method="post">
                      <input type="hidden" name="page_id" value={page.id} />
                      <button
                        type="submit"
                        disabled={!allowed}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                      >
                        {allowed ? 'Chọn và kết nối' : 'Không thuộc workspace'}
                      </button>
                    </form>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-400">
        <div className="font-semibold text-slate-200">Dùng cho Meta App Review</div>
        <p className="mt-2 leading-6">
          Khi quay screencast, bắt đầu tại trang này → bấm “Kết nối / xác minh lại bằng
          Facebook” → hoàn tất Facebook Login → quay lại danh sách Page → chọn Page “Cửa
          chống ngập” → cho reviewer thấy trạng thái kết nối thành công → mở Hộp thư để
          chứng minh Messenger hoạt động hai chiều.
        </p>
      </section>
    </div>
  );
}
