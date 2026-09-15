'use client';

import React, { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { enrollMfaAction, verifyMfaAction } from '../../../../(auth)/actions';

export default function MfaEnrollPage() {
  const router = useRouter();
  const [enrollData, setEnrollData] = useState<{
    factorId: string;
    qrCode: string;
    secret: string;
  } | null>(null);
  const [code, setCode] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    async function initEnrollment() {
      setIsInitializing(true);
      setErrorMessage(null);
      const res = await enrollMfaAction();
      if (!res.success || !res.data) {
        setErrorMessage(res.error || 'Không thể khởi tạo mã xác thực TOTP.');
      } else {
        setEnrollData({
          factorId: res.data.factorId,
          qrCode: res.data.qrCode,
          secret: res.data.secret,
        });
      }
      setIsInitializing(false);
    }

    initEnrollment();
  }, []);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!enrollData) return;

    if (code.trim().length !== 6) {
      setErrorMessage('Vui lòng nhập đúng 6 chữ số từ ứng dụng xác thực.');
      return;
    }

    setErrorMessage(null);

    startTransition(async () => {
      const res = await verifyMfaAction(enrollData.factorId, code.trim());
      if (!res.success) {
        setErrorMessage(res.error || 'Mã xác thực không chính xác. Vui lòng thử lại.');
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
        Đang khởi tạo mã bí mật TOTP...
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/30 mb-3">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-white">Kích hoạt Xác thực 2 Yếu tố (MFA)</h1>
          <p className="text-xs text-slate-400 mt-1">
            Theo chính sách bảo mật AUTH DECISION 01, tài khoản Quản trị viên (Sếp) bắt buộc đạt cấp độ AAL2 để truy cập dữ liệu nhạy cảm.
          </p>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
            {errorMessage}
          </div>
        )}

        {enrollData && (
          <div className="space-y-4">
            <div className="text-center p-4 bg-slate-950/80 rounded-xl border border-slate-800">
              <p className="text-xs font-medium text-slate-300 mb-3">
                1. Quét mã QR bằng ứng dụng Authenticator (Google Authenticator, Authy, Apple):
              </p>
              {enrollData.qrCode ? (
                <div className="flex justify-center my-2 p-2 bg-white rounded-lg inline-block mx-auto">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={enrollData.qrCode}
                    alt="Mã QR TOTP"
                    className="w-44 h-44 object-contain"
                  />
                </div>
              ) : null}
              <div className="mt-2 text-left">
                <p className="text-[11px] text-slate-500 mb-1">Hoặc nhập mã khóa thủ công:</p>
                <code className="block p-2 rounded bg-slate-900 font-mono text-xs text-blue-400 break-all select-all border border-slate-800">
                  {enrollData.secret}
                </code>
              </div>
            </div>

            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-300 mb-1">
                  2. Nhập mã 6 chữ số từ ứng dụng
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="w-full text-center tracking-[0.5em] font-mono text-2xl py-3 rounded-xl bg-slate-950 border border-slate-700 text-white placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <button
                type="submit"
                disabled={isPending || code.length !== 6}
                className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isPending ? 'Đang xác thực...' : 'Xác nhận & Kích hoạt AAL2'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
