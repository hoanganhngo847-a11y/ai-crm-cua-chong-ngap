'use client';

import React, { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { enrollMfaAction, verifyMfaAction } from '../../../../(auth)/actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShieldCheck, AlertCircle } from 'lucide-react';

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
      <div className="max-w-md mx-auto p-8 text-center text-text-tertiary text-sm">
        Đang khởi tạo mã bí mật TOTP...
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6 pt-6">
      <Card className="p-6 shadow-sm space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent-soft text-accent border border-accent/20 mb-3">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-semibold text-text-primary">Kích hoạt Xác thực 2 Yếu tố (MFA)</h1>
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            Theo chính sách bảo mật AUTH DECISION 01, tài khoản Quản trị viên (Sếp) bắt buộc đạt cấp độ AAL2 để truy cập dữ liệu nhạy cảm.
          </p>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {enrollData && (
          <div className="space-y-4">
            <div className="text-center p-4 bg-surface-secondary rounded-xl border border-border-subtle">
              <p className="text-xs font-medium text-text-primary mb-3">
                1. Quét mã QR bằng ứng dụng Authenticator (Google Authenticator, Authy, Apple):
              </p>
              {enrollData.qrCode ? (
                <div className="flex justify-center my-2 p-2 bg-white rounded-lg border border-border-subtle inline-block mx-auto shadow-xs">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={enrollData.qrCode}
                    alt="Mã QR TOTP"
                    className="w-48 h-48 object-contain"
                  />
                </div>
              ) : (
                <div className="text-xs text-text-tertiary italic">Đang tải mã QR...</div>
              )}

              <div className="mt-3 pt-3 border-t border-border-subtle text-left">
                <span className="text-[11px] text-text-tertiary block mb-1">
                  Hoặc nhập khóa bảo mật thủ công:
                </span>
                <code className="text-xs font-mono font-bold text-accent bg-surface-primary px-2 py-1 rounded border border-border-subtle block text-center break-all select-all">
                  {enrollData.secret}
                </code>
              </div>
            </div>

            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1">
                  2. Nhập mã gồm 6 chữ số từ ứng dụng xác thực:
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
                  className="w-full text-center tracking-[0.5em] text-xl font-mono py-2.5 rounded-lg border border-border-subtle bg-surface-primary text-text-primary focus:outline-none focus:border-accent"
                />
              </div>

              <Button
                type="submit"
                variant="primary"
                size="md"
                className="w-full"
                disabled={isPending || code.length !== 6}
              >
                {isPending ? 'Đang xác thực...' : 'Kích hoạt và Tiếp tục'}
              </Button>
            </form>
          </div>
        )}
      </Card>
    </div>
  );
}
