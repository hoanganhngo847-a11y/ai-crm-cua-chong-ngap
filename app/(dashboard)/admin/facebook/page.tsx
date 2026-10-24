import Link from 'next/link';

import { getActorContext } from '@/lib/auth/context';
import {
  configuredFacebookPageIds,
  getConfiguredFacebookConnections,
  readFacebookConnectSession,
} from '@/features/omnichannel/facebook/connect';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertCircle, MessageSquare } from 'lucide-react';

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
      <PageHeader
        breadcrumbs={[
          { label: 'Quản trị hệ thống', href: '/admin' },
          { label: 'Kết nối Facebook Page' },
        ]}
        title="Kết nối Facebook Page"
        description="Đăng nhập Facebook để xác minh các Page quản lý. CRM hỗ trợ nhiều Page cùng lúc, tin nhắn phản hồi luôn giữ đúng Page nguồn."
        primaryAction={
          <Link
            href="/inbox"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-border-subtle bg-surface-primary hover:bg-surface-hover text-text-primary text-xs font-medium transition shadow-xs"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>Mở Hộp thư</span>
          </Link>
        }
      />

      {errorCode && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Không thể hoàn tất kết nối</div>
            <div className="mt-0.5 text-xs text-rose-700">
              {ERROR_MESSAGES[errorCode] || errorCode}
            </div>
          </div>
        </div>
      )}

      {connected && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Kết nối thành công</div>
            <div className="mt-0.5 text-xs text-emerald-700">
              Đã đăng ký webhook Messenger cho {connectedCount || 1} Page
              {connectedPages ? `: ${connectedPages}` : '.'}
            </div>
          </div>
        </div>
      )}

      {/* Guide Steps */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Bước 1</div>
          <h2 className="text-sm font-semibold text-text-primary">Đăng nhập Facebook</h2>
          <p className="text-xs text-text-secondary leading-relaxed">
            Boss Admin có AAL2 đăng nhập và cấp pages_show_list, pages_manage_metadata, pages_messaging.
          </p>
        </Card>
        <Card className="p-5 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Bước 2</div>
          <h2 className="text-sm font-semibold text-text-primary">Xác minh các Page</h2>
          <p className="text-xs text-text-secondary leading-relaxed">
            Nếu workspace chỉ có một Page, Page đó được chọn sẵn. Khi có nhiều Page, Boss có thể kết nối nhiều Page trong cùng một lần.
          </p>
        </Card>
        <Card className="p-5 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Bước 3</div>
          <h2 className="text-sm font-semibold text-text-primary">Đăng ký webhook</h2>
          <p className="text-xs text-text-secondary leading-relaxed">
            CRM subscribe trường messages cho từng Page đã chọn. Tin nhắn sau đó được định tuyến theo Page ID riêng.
          </p>
        </Card>
      </section>

      {/* Configured Pages Section */}
      <Card className="p-6 space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Các Page của workspace</h2>
            <p className="mt-1 text-xs text-text-secondary">
              Runtime có thể nhận và gửi song song trên tất cả Page đã cấu hình.
            </p>
          </div>
          <Badge variant={fullyConnected ? 'success' : connections.length > 0 ? 'warning' : 'neutral'}>
            {fullyConnected
              ? `${connections.length} Page đã kết nối webhook`
              : connections.length > 0
                ? `${connections.length} Page đã cấu hình · cần kiểm tra subscription`
                : 'Chưa cấu hình Page'}
          </Badge>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {connections.length === 0 ? (
            <div className="rounded-lg border border-border-subtle bg-surface-secondary p-4 text-xs text-text-secondary md:col-span-2 text-center">
              Chưa có Facebook Page nào được cấu hình cho workspace.
            </div>
          ) : (
            connections.map((connection) => (
              <div
                key={connection.pageId || 'unknown'}
                className="rounded-lg border border-border-subtle bg-surface-secondary p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] text-text-tertiary">Facebook Page</div>
                    <div className="mt-1 font-semibold text-text-primary text-sm">
                      {connection.pageName || 'Chưa lấy được tên Page'}
                    </div>
                    <div className="mt-1 font-mono text-xs text-text-secondary">
                      {connection.pageId}
                    </div>
                  </div>
                  <Badge variant={connection.subscribed ? 'success' : 'warning'}>
                    {connection.subscribed ? 'Webhook OK' : 'Cần xác minh'}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="pt-2 border-t border-border-subtle">
          <a
            href="/api/facebook/connect/start"
            className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-accent-hover transition"
          >
            Kết nối / xác minh các Facebook Page
          </a>
          <p className="mt-2 text-[11px] text-text-tertiary">
            Access token onboarding chỉ tồn tại trong cookie HttpOnly mã hóa tối đa 10 phút. Token runtime của từng Page vẫn nằm trong cấu hình secret phía server.
          </p>
        </div>
      </Card>

      {/* Found Pages in Current Session */}
      {session && session.companyId === companyId && (
        <Card className="p-6 space-y-5 border-accent/40 bg-accent-soft/30">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-text-primary">Các Facebook Page tìm thấy</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Meta trả về {session.pages.length} Page mà tài khoản vừa đăng nhập đang quản lý.
              </p>
            </div>
            <Badge variant="info">
              pages_show_list
            </Badge>
          </div>

          {session.pages.length === 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
              Facebook không trả về Page nào. Hãy kiểm tra tài khoản vừa đăng nhập có quyền quản lý Page hay không.
            </div>
          ) : (
            <form action="/api/facebook/connect/select" method="post" className="space-y-4">
              <div className="grid gap-3">
                {session.pages.map((page) => {
                  const allowed = configuredPageIds.has(page.id);
                  return (
                    <label
                      key={page.id}
                      className={`flex items-center gap-3 rounded-lg border p-3.5 transition ${
                        allowed
                          ? 'cursor-pointer border-border-subtle bg-surface-primary hover:border-accent'
                          : 'cursor-not-allowed border-border-subtle bg-surface-secondary opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        name="page_id"
                        value={page.id}
                        defaultChecked={allowed}
                        disabled={!allowed}
                        className="h-4 w-4 rounded border-border-strong text-accent focus:ring-accent"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-text-primary text-xs">{page.name}</span>
                          {allowed ? (
                            <Badge variant="success">
                              Thuộc workspace
                            </Badge>
                          ) : (
                            <Badge variant="neutral">
                              Chưa cấu hình runtime
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-text-tertiary">{page.id}</div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!session.pages.some((page) => configuredPageIds.has(page.id))}
              >
                Kết nối các Page đã chọn
              </Button>
            </form>
          )}
        </Card>
      )}

      {/* Meta App Review Note */}
      <Card className="p-4 text-xs text-text-secondary bg-surface-secondary">
        <div className="font-semibold text-text-primary mb-1">Dùng cho Meta App Review</div>
        <p className="leading-relaxed">
          Khi quay screencast: mở trang này → bấm “Kết nối / xác minh các Facebook Page” → hoàn tất Facebook Login → cho reviewer thấy danh sách Page từ Meta → Page của workspace được chọn → bấm kết nối → mở Hộp thư và chứng minh Messenger hai chiều.
        </p>
      </Card>
    </div>
  );
}
