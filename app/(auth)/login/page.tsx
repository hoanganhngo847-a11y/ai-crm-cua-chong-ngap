'use client';

import React, { Suspense, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { loginAction } from './actions';
import { sanitizeRedirectPath } from '../../../lib/auth/redirect';
import { Button } from '@/components/ui/button';
import { ShieldCheck, AlertCircle } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await loginAction(formData);

      if (!result.success) {
        setErrorMessage(result.error || 'Đăng nhập thất bại.');
        return;
      }

      const serverDestination = result.redirectTo || '/crm';
      const safeRedirect = sanitizeRedirectPath(
        searchParams.get('redirect_to'),
        serverDestination
      );
      router.push(safeRedirect);
      router.refresh();
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--app-canvas)] p-4">
      <div className="w-full max-w-sm bg-white border border-border-subtle rounded-2xl shadow-xs p-8 transition-all">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-accent-soft text-accent border border-accent/20 mb-3.5 shadow-xs">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            AI CRM Đa Kênh
          </h1>
          <p className="text-xs text-text-secondary mt-1">
            Hệ thống quản lý khách hàng sản xuất cửa chống ngập
          </p>
        </div>

        {errorMessage && (
          <div
            id="login-error-alert"
            className="mb-5 p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5"
            role="alert"
          >
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium text-text-secondary mb-1.5"
            >
              Email công việc
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="ten@cuachongngap.vn"
              className="w-full px-3 py-2 text-xs rounded-lg bg-surface-primary border border-border-subtle text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="password"
                className="block text-xs font-medium text-text-secondary"
              >
                Mật khẩu
              </label>
            </div>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full px-3 py-2 text-xs rounded-lg bg-surface-primary border border-border-subtle text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="pt-1">
            <Button
              id="login-submit-button"
              type="submit"
              variant="primary"
              size="md"
              className="w-full justify-center"
              disabled={isPending}
            >
              {isPending ? 'Đang xử lý...' : 'Đăng nhập'}
            </Button>
          </div>
        </form>

        <div className="mt-6 pt-5 border-t border-border-subtle text-center">
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            Hệ thống nội bộ được bảo vệ bởi Supabase Auth & RLS.
            <br />
            Chỉ nhân sự được cấp quyền mới có thể truy cập.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-[var(--app-canvas)] text-text-tertiary text-sm">
          Đang tải...
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
