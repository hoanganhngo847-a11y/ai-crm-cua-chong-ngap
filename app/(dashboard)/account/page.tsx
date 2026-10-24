'use client';

import React, { useState, useTransition } from 'react';
import { selfChangePasswordAction } from '../../(auth)/actions';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Lock, CheckCircle2, AlertCircle } from 'lucide-react';

export default function AccountPage() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setStatusMessage(null);

    if (newPassword !== confirmPassword) {
      setStatusMessage({ type: 'error', text: 'Mật khẩu xác nhận không khớp.' });
      return;
    }

    if (newPassword.length < 8) {
      setStatusMessage({ type: 'error', text: 'Mật khẩu phải có tối thiểu 8 ký tự.' });
      return;
    }

    startTransition(async () => {
      const result = await selfChangePasswordAction(newPassword);
      if (!result.success) {
        setStatusMessage({ type: 'error', text: result.error || 'Đổi mật khẩu thất bại.' });
      } else {
        setStatusMessage({
          type: 'success',
          text: 'Đổi mật khẩu thành công! Các phiên đăng nhập trên thiết bị khác đã được thu hồi (scope: others).',
        });
        setNewPassword('');
        setConfirmPassword('');
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Cá nhân' },
          { label: 'Tài khoản' },
        ]}
        title="Quản lý Tài khoản Cá nhân"
        description="Cập nhật thông tin bảo mật và quản lý phiên đăng nhập."
      />

      <Card className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0 mt-0.5">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Đổi mật khẩu</h2>
            <p className="text-xs text-text-secondary mt-1 leading-relaxed">
              Theo AUTH DECISION 03: Khi bạn tự đổi mật khẩu, phiên làm việc hiện tại được tiếp tục, toàn bộ các phiên đăng nhập trên thiết bị khác sẽ bị thu hồi ngay lập tức (scope: others).
            </p>
          </div>
        </div>

        {statusMessage && (
          <div
            className={`p-3.5 rounded-lg text-xs flex items-center gap-2.5 ${
              statusMessage.type === 'success'
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border border-rose-200 text-rose-800'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        <form onSubmit={handlePasswordChange} className="space-y-4 pt-2">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Mật khẩu mới (tối thiểu 8 ký tự)
            </label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-primary border border-border-subtle text-text-primary text-xs placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">
              Xác nhận mật khẩu mới
            </label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-surface-primary border border-border-subtle text-text-primary text-xs placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            />
          </div>

          <div className="pt-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={isPending}
            >
              {isPending ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
