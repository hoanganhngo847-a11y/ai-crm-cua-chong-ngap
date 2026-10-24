'use client';

import React, { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  getEnrolledFactorIdAction,
  verifyMfaAction,
} from '../../../../(auth)/actions';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShieldCheck, AlertCircle } from 'lucide-react';

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
      <div className="max-w-md mx-auto p-8 text-center text-text-tertiary text-sm">
        Đang kiểm tra trạng thái xác thực...
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
          <h1 className="text-lg font-semibold text-text-primary">Xác thực Hai Yếu tố (MFA / AAL2)</h1>
          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
            Nhập mã gồm 6 chữ số từ ứng dụng Authenticator của bạn để tiếp tục vào Khu vực Quản trị.
          </p>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2 text-center">
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
              className="w-full text-center tracking-[0.5em] text-2xl font-mono py-2.5 rounded-lg border border-border-subtle bg-surface-primary text-text-primary focus:outline-none focus:border-accent"
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            size="md"
            className="w-full"
            disabled={isPending || code.length !== 6}
          >
            {isPending ? 'Đang xác thực...' : 'Xác nhận và Đăng nhập'}
          </Button>
        </form>

        <div className="text-center pt-2 border-t border-border-subtle">
          <p className="text-[11px] text-text-tertiary">
            Mất quyền truy cập thiết bị xác thực? Vui lòng liên hệ bộ phận hỗ trợ kỹ thuật để khôi phục.
          </p>
        </div>
      </Card>
    </div>
  );
}
