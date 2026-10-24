'use client';
import { useEffect, useState } from 'react';
import { listZaloDevices, registerZaloDevice, revokeZaloDevice } from '../../../actions/zalo-recordings';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Laptop, AlertCircle } from 'lucide-react';

function formatRelativeTime(dateString: string | null): string {
  if (!dateString) return 'Chưa có kết nối';
  const diffMs = Date.now() - new Date(dateString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return 'Vừa xong';
  if (diffSec < 60) return `${diffSec} giây trước`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} phút trước`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} giờ trước`;
  return new Date(dateString).toLocaleString('vi-VN');
}

function getStaffName(staffList: Awaited<ReturnType<typeof listZaloDevices>>['staff'] | undefined, staffId: string | null): string {
  if (!staffId || !staffList) return 'Máy dùng chung';
  const member = staffList.find((s) => s.user_id === staffId);
  if (!member?.user_profiles) return 'Máy dùng chung';
  const profile = (Array.isArray(member.user_profiles) ? member.user_profiles[0] : member.user_profiles) as { full_name?: string } | null;
  return profile?.full_name || member.user_id;
}

export default function DeviceManager() {
  const [data, setData] = useState<Awaited<ReturnType<typeof listZaloDevices>> | null>(null);
  const [id, setId] = useState(''), [name, setName] = useState(''), [staff, setStaff] = useState('');
  const [credential, setCredential] = useState<{ device_id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    const fetchDevices = () => {
      listZaloDevices().then((value) => {
        if (active) setData(value);
      }).catch(() => {
        if (active) setError('Không tải được thiết bị.');
      });
    };
    fetchDevices();
    const interval = setInterval(fetchDevices, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [version]);

  return (
    <div className="space-y-6">
      <p className="text-xs text-text-secondary leading-relaxed">
        Mỗi đăng ký dành cho một tài khoản Zalo trên một máy Mac. Khi đổi tài khoản Zalo, thu hồi thiết bị và đăng ký context mới trước khi bật upload. Tên hiển thị không phải Zalo UID.
      </p>

      {/* Device Registration Form */}
      <Card className="p-5 max-w-xl space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-border-subtle">
          <Laptop className="w-4 h-4 text-accent" />
          <h3 className="font-semibold text-text-primary text-xs">Đăng ký thiết bị Mac mới</h3>
        </div>
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            setCredential(null);
            try {
              setCredential(await registerZaloDevice(id, name, staff || null));
              setVersion((v) => v + 1);
              setId('');
              setName('');
            } catch {
              setError('Đăng ký chưa thành công. Kiểm tra Device ID mới và nhân viên hợp lệ.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block text-xs font-medium text-text-secondary">
            Device ID từ lệnh <code className="text-accent font-mono">bash local-agent/run.sh --device-id</code>
            <input
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="UUID của Mac (ví dụ: 0fb85e57-25d1-4c73-ac69-7522097c1604)"
              className="mt-1 block w-full rounded-lg bg-surface-primary border border-border-subtle p-2 text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            Tên thiết bị (ví dụ: MacBook Air - Sales 01)
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 block w-full rounded-lg bg-surface-primary border border-border-subtle p-2 text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </label>
          <label className="block text-xs font-medium text-text-secondary">
            Nhân viên phụ trách
            <select
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
              className="mt-1 block w-full rounded-lg bg-surface-primary border border-border-subtle p-2 text-xs text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">Máy dùng chung — tất cả nhân sự được quyền gọi</option>
              {data?.staff.map((member) => {
                const profile = (Array.isArray(member.user_profiles) ? member.user_profiles[0] : member.user_profiles) as { full_name: string } | null;
                return (
                  <option key={member.user_id} value={member.user_id}>
                    {profile?.full_name || member.user_id} ({member.role})
                  </option>
                );
              })}
            </select>
          </label>
          <div className="pt-1">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy}
            >
              {busy ? 'Đang đăng ký...' : 'Đăng ký thiết bị'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Secret Display Alert */}
      {credential && (
        <div className="max-w-xl space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-xs text-amber-900">
            <strong>Lưu ý:</strong> Secret chỉ hiển thị một lần duy nhất này. Chạy lệnh sau trên máy Mac để cấu hình agent:
            <code className="block mt-1 p-1 bg-surface-primary border border-amber-200 rounded text-amber-900 font-mono text-[11px]">
              bash local-agent/run.sh --configure-upload
            </code>
          </p>
          <label className="block text-xs font-medium text-amber-900">
            Device Secret (Token HMAC)
            <textarea
              aria-label="Device secret"
              readOnly
              value={credential.secret}
              className="mt-1 block w-full break-all rounded-lg bg-surface-primary border border-amber-300 p-2 font-mono text-xs text-amber-950"
              rows={2}
            />
          </label>
          <button onClick={() => setCredential(null)} className="text-xs text-amber-800 hover:underline font-medium">
            Đã sao chép vào Keychain, ẩn secret này
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 font-medium flex items-center gap-2 max-w-xl">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Devices List */}
      <div className="space-y-3">
        <h3 className="font-semibold text-text-primary text-xs">
          Danh sách thiết bị Mac ({data?.devices.length || 0})
        </h3>
        {data?.devices.length === 0 ? (
          <Card className="p-8 text-center text-xs text-text-tertiary">
            Chưa có thiết bị nào được đăng ký.
          </Card>
        ) : (
          <ul className="space-y-3">
            {data?.devices.map((device) => {
              const status = device.effective_status;
              const permissions = (device.permissions_detail || {}) as Record<string, boolean>;
              const missingPermissions: string[] = [];
              if (permissions.accessibility === false) missingPermissions.push('Trợ năng (Accessibility)');
              if (permissions.microphone === false) missingPermissions.push('Microphone');
              if (permissions.screen_recording === false) missingPermissions.push('Ghi màn hình/Âm thanh');
              if (device.loopback_ready === false) missingPermissions.push('Loopback (127.0.0.1:48123)');

              return (
                <li key={device.id}>
                  <Card className="p-4 text-xs space-y-3 hover:border-border-strong transition-colors">
                    {/* Header: Name, Status badge, Version */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-text-primary text-sm">{device.device_name}</span>
                        <span className="font-mono text-[10px] text-text-secondary px-1.5 py-0.5 rounded bg-surface-secondary border border-border-subtle">
                          v{device.agent_version || '1.0.0'}
                        </span>
                      </div>

                      {/* Status Badge */}
                      <Badge variant={status === 'ONLINE' ? 'success' : status === 'DEGRADED' ? 'warning' : 'neutral'}>
                        {status}
                      </Badge>
                    </div>

                    {/* Operational Details Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 text-text-secondary pt-0.5">
                      <div>
                        <span className="text-text-tertiary block text-[11px]">Device ID:</span>
                        <span className="font-mono text-[11px] text-text-primary break-all">{device.id}</span>
                      </div>

                      <div>
                        <span className="text-text-tertiary block text-[11px]">Heartbeat gần nhất:</span>
                        <span className="text-text-primary font-medium">{formatRelativeTime(device.last_seen_at)}</span>
                      </div>

                      <div>
                        <span className="text-text-tertiary block text-[11px]">Zalo Desktop:</span>
                        <span className={device.zalo_running ? 'text-emerald-700 font-medium' : 'text-text-tertiary'}>
                          {device.zalo_running ? '● Đang chạy' : '○ Chưa mở'}
                        </span>
                      </div>

                      <div>
                        <span className="text-text-tertiary block text-[11px]">Quyền hệ thống:</span>
                        {device.permissions_ok ? (
                          <span className="text-emerald-700 font-medium">✓ Đầy đủ (OK)</span>
                        ) : (
                          <span className="text-amber-800 font-medium">
                            {missingPermissions.length > 0 ? `Thiếu: ${missingPermissions.join(', ')}` : 'Chưa xác thực'}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Degraded Reason Alert if applicable */}
                    {status === 'DEGRADED' && missingPermissions.length > 0 && (
                      <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-amber-800 text-[11px]">
                        <strong>Cảnh báo khả dụng:</strong> Agent đang hoạt động nhưng chưa cấp đủ quyền: {missingPermissions.join(', ')}. Hãy mở Cài đặt Hệ thống trên máy Mac để cấp quyền.
                      </div>
                    )}

                    {/* Footer: Staff & Action */}
                    <div className="flex items-center justify-between pt-1 border-t border-border-subtle">
                      <span className="text-text-tertiary text-[11px]">
                        Nhân viên phụ trách:{' '}
                        <strong className="text-text-primary font-medium">
                          {getStaffName(data?.staff, device.staff_user_id)}
                        </strong>
                      </span>

                      {device.active && (
                        <button
                          disabled={busy}
                          onClick={async () => {
                            if (!confirm(`Bạn có chắc muốn thu hồi thiết bị "${device.device_name}" không?`)) return;
                            setBusy(true);
                            setError('');
                            try {
                              await revokeZaloDevice(device.id);
                              setCredential(null);
                              setVersion((v) => v + 1);
                            } catch {
                              setError('Chưa thu hồi được thiết bị.');
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="text-danger hover:underline text-xs font-medium disabled:opacity-50"
                        >
                          Thu hồi thiết bị
                        </button>
                      )}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
