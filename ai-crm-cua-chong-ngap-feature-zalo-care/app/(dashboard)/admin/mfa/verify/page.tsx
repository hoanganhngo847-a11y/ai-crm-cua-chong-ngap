'use client';

import React, { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  getEnrolledFactorIdAction,
  verifyMfaAction,
} from '../../../../(auth)/actions';

export default function MfaVerifyPage() {
  const router = useRouter();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    async function loadFactor() {
      setIsInitializing(true);
      setErrorMessage(null);
      const res = await getEnrolledFactorIdAction();
      if (!res.success || !res.factorId) {
        // No factor enrolled -> redirect to enrollment
        router.push('/admin/mfa/enroll');
        return;
      }
      setFactorId(res.factorId);
      setIsInitializing(false);
    }

    loadFactor();
  }, [router]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;

    if (code.trim().length !== 6) {
      setErrorMessage('Vui lòng nhập đủ 6 chữ số từ ứng dụng xác thực.');
      return;
    }

    setErrorMessage(null);

    startTransition(async () => {
      const res = await verifyMfaAction(factorId, code.trim());
      if (!res.success) {
        setErrorMessage(res.error || 'Mã xác thực không chính xác.');
        return;
      }

      // Successfully reached AAL2
      router.push('/admin');
      router.refresh();
    });
  }

  if (isInitializing) {
    return (
      <div className="max-w-md mx-auto p-8 text-center text-slate-400">
        Đang kiểm tra trạng thái xác thực...
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/30 mb-3">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white">Xác thực Hai Yếu tố (MFA / AAL2)</h1>
          <p className="text-xs text-slate-400 mt-1">
            Nhập mã gồm 6 chữ số từ ứng dụng Authenticator của bạn để tiếp tục vào Khu vực Quản trị.
          </p>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2 text-center">
              Mã bảo mật TOTP (6 chữ số)
            </label>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="w-full text-center tracking-[0.5em] font-mono text-3xl py-3.5 rounded-xl bg-slate-950 border border-slate-700 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <button
            type="submit"
            disabled={isPending || code.length !== 6}
            className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25"
          >
            {isPending ? 'Đang xác thực...' : 'Xác thực & Truy cập'}
          </button>
        </form>

        <div className="text-center pt-2 border-t border-slate-800">
          <a
            href="/admin/mfa/enroll"
            className="text-xs text-slate-400 hover:text-blue-400 transition"
          >
            Đăng ký lại thiết bị Authenticator mới?
          </a>
        </div>
      </div>
    </div>
  );
}
