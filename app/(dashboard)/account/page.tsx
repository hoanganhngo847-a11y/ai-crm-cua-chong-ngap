'use client';

import React, { useState, useTransition } from 'react';
import { selfChangePasswordAction } from '../../(auth)/actions';

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
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Quản lý Tài khoản Cá nhân</h1>
        <p className="text-sm text-slate-400">
          Cập nhật thông tin bảo mật và quản lý phiên đăng nhập.
        </p>
      </div>

      <div className="p-6 bg-slate-900 border border-slate-800 rounded-xl space-y-4">
        <h2 className="text-lg font-semibold text-white">Đổi mật khẩu</h2>
        <p className="text-xs text-slate-400">
          Theo AUTH DECISION 03: Khi bạn tự đổi mật khẩu, phiên làm việc hiện tại được tiếp tục, toàn bộ các phiên đăng nhập trên thiết bị khác sẽ bị thu hồi ngay lập tức (scope: others).
        </p>

        {statusMessage && (
          <div
            className={`p-3 rounded-lg text-sm ${
              statusMessage.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                : 'bg-red-500/10 border border-red-500/30 text-red-300'
            }`}
          >
            {statusMessage.text}
          </div>
        )}

        <form onSubmit={handlePasswordChange} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
              Mật khẩu mới (tối thiểu 8 ký tự)
            </label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
              Xác nhận mật khẩu mới
            </label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={isPending}
            className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition disabled:opacity-50"
          >
            {isPending ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}
          </button>
        </form>
      </div>
    </div>
  );
}
