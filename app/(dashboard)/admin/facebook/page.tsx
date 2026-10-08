import Link from 'next/link';

import { getActorContext } from '@/lib/auth/context';
import {
  configuredFacebookPageIds,
  getConfiguredFacebookConnections,
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
    'Có Page đã chọn chưa được cấu hình cho workspace CRM hiện tại.',
  FACEBOOK_SUBSCRIBE_FAILED: 'Không thể đăng ký Page với webhook Messenger.',
  FACEBOOK_CONNECT_SELECT_FAILED: 'Không thể hoàn tất kết nối Page.',
  FACEBOOK_CONNECT_START_FAILED: 'Không thể bắt đầu đăng nhập Facebook.',
  INVALID_PAGE: 'Vui lòng chọn ít nhất một Page hợp lệ.',
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
  const connectedPages = textParam(params.pages);
  const connectedCount = Number(textParam(params.count) || 0);
  const actor = await getActorContext();
  const companyId = actor?.companyId || '';

  const [connections, session] = await Promise.all([
    getConfiguredFacebookConnections(companyId),
    readFacebookConnectSession(),
  ]);
  const configuredPageIds = configuredFacebookPageIds(companyId);
  const fullyConnected =
    connections.length > 0 && connections.every((connection) => connection.subscribed);

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
            Boss Admin đăng nhập Facebook một lần để xác minh các Page mình quản lý. CRM
            hỗ trợ nhiều Page cùng lúc; mỗi hội thoại luôn giữ Page nguồn để Sale biết khách
            đang nhắn vào Page nào và trả lời đúng Page đó.
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
            Đã đăng ký webhook Messenger cho {connectedCount || 1} Page
            {connectedPages ? `: ${connectedPages}` : '.'}
          </div>
        </div>
      )}

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Bước 1</div>
          <h2 className="mt-2 text-lg font-semibold text-white">Đăng nhập Facebook</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Boss Admin có AAL2 đăng nhập và cấp pages_show_list, pages_manage_metadata,
            pages_messaging.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Bước 2</div>
          <h2 className="mt-2 text-lg font-semibold text-white">Xác minh các Page</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Nếu workspace chỉ có một Page, Page đó được chọn sẵn. Khi có nhiều Page, Boss
            có thể kết nối nhiều Page trong cùng một lần.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Bước 3</div>
          <h2 className="mt-2 text-lg font-semibold text-white">Đăng ký webhook</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            CRM subscribe trường messages cho từng Page đã chọn. Tin nhắn sau đó được định
            tuyến theo Page ID riêng, không trộn giữa các Page.
          </p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Các Page của workspace</h2>
            <p className="mt-1 text-sm text-slate-400">
              Runtime có thể nhận và gửi song song trên tất cả Page đã cấu hình.
            </p>
          </div>
          <div
            className={`inline-flex w-fit items-center rounded-full px-3 py-1 text-xs font-semibold ${
              fullyConnected
                ? 'bg-emerald-500/15 text-emerald-300'
                : connections.length > 0
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-slate-800 text-slate-400'
            }`}
          >
            {fullyConnected
              ? `${connections.length} Page đã kết nối webhook`
              : connections.length > 0
                ? `${connections.length} Page đã cấu hình · cần kiểm tra subscription`
                : 'Chưa cấu hình Page'}
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {connections.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400 md:col-span-2">
              Chưa có Facebook Page nào được cấu hình cho workspace.
            </div>
          ) : (
            connections.map((connection) => (
              <div
                key={connection.pageId || 'unknown'}
                className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs text-slate-500">Facebook Page</div>
                    <div className="mt-1 font-medium text-slate-100">
                      {connection.pageName || 'Chưa lấy được tên Page'}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-slate-500">
                      {connection.pageId}
                    </div>
                  </div>
                  <span
                    className={`rounded-full px-2 py-1 text-[10px] font-semibold ${
                      connection.subscribed
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-amber-500/15 text-amber-300'
                    }`}
                  >
                    {connection.subscribed ? 'Webhook OK' : 'Cần xác minh'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5">
          <a
            href="/api/facebook/connect/start"
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
          >
            Kết nối / xác minh các Facebook Page
          </a>
          <p className="mt-2 text-xs text-slate-500">
            Access token onboarding chỉ tồn tại trong cookie HttpOnly mã hóa tối đa 10 phút.
            Token runtime của từng Page vẫn nằm trong cấu hình secret phía server.
          </p>
        </div>
      </section>

      {session && session.companyId === companyId && (
        <section className="rounded-2xl border border-blue-800/60 bg-blue-950/20 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">Các Facebook Page tìm thấy</h2>
              <p className="mt-1 text-sm text-slate-400">
                Meta trả về {session.pages.length} Page mà tài khoản vừa đăng nhập đang quản
                lý. Page thuộc workspace được chọn sẵn; khi có nhiều Page bạn có thể kết nối
                nhiều Page cùng một lúc.
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
            <form action="/api/facebook/connect/select" method="post" className="mt-5 space-y-4">
              <div className="grid gap-3">
                {session.pages.map((page) => {
                  const allowed = configuredPageIds.has(page.id);
                  return (
                    <label
                      key={page.id}
                      className={`flex items-center gap-3 rounded-xl border p-4 ${
                        allowed
                          ? 'cursor-pointer border-slate-700 bg-slate-950/60'
                          : 'cursor-not-allowed border-slate-800 bg-slate-950/30 opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        name="page_id"
                        value={page.id}
                        defaultChecked={allowed}
                        disabled={!allowed}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-slate-100">{page.name}</span>
                          {allowed ? (
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                              Thuộc workspace
                            </span>
                          ) : (
                            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-500">
                              Chưa cấu hình runtime
                            </span>
                          )}
                        </div>
                        <div className="mt-1 font-mono text-xs text-slate-500">{page.id}</div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <button
                type="submit"
                disabled={!session.pages.some((page) => configuredPageIds.has(page.id))}
                className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                Kết nối các Page đã chọn
              </button>
            </form>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-400">
        <div className="font-semibold text-slate-200">Dùng cho Meta App Review</div>
        <p className="mt-2 leading-6">
          Khi quay screencast: mở trang này → bấm “Kết nối / xác minh các Facebook Page” →
          hoàn tất Facebook Login → cho reviewer thấy danh sách Page từ Meta → Page của
          workspace được chọn → bấm kết nối → mở Hộp thư và chứng minh Messenger hai chiều.
        </p>
      </section>
    </div>
  );
}
