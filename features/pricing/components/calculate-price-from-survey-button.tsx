'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import { calculatePriceFromSurveyAction } from '../../../app/(dashboard)/surveys/actions';

interface CalculatePriceFromSurveyButtonProps {
  surveyId: string;
  userRole?: string;
  initialStatus?: string;
  initialAmount?: number | null;
  buttonLabel?: string;
  className?: string;
}

export default function CalculatePriceFromSurveyButton({
  surveyId,
  userRole = '',
  initialStatus,
  initialAmount,
  buttonLabel = 'Tính giá từ khảo sát',
  className = '',
}: CalculatePriceFromSurveyButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    status?: string;
    amount?: number | null;
    missingFields?: string[];
    message?: string;
    calculationId?: string;
  } | null>(
    initialStatus
      ? {
          status: initialStatus,
          amount: initialAmount,
        }
      : null
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const isAuthorized = userRole === 'BOSS_ADMIN' || userRole === 'SALE';

  if (!isAuthorized) {
    return null;
  }

  const handleCalculate = () => {
    if (isPending) return;
    setErrorMsg(null);

    startTransition(async () => {
      try {
        const res = await calculatePriceFromSurveyAction({ surveyId });
        if (res.success) {
          setResult({
            status: res.status,
            amount: res.amount,
            missingFields: res.missingFields,
            message: res.message,
            calculationId: res.calculationId,
          });
        } else {
          setErrorMsg(res.message || 'Không thể tính giá từ khảo sát.');
        }
      } catch (err: unknown) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Lỗi hệ thống khi tính giá từ khảo sát.'
        );
      }
    });
  };

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleCalculate}
          disabled={isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-500 hover:to-emerald-500 text-white text-xs font-semibold shadow-md shadow-teal-600/20 disabled:opacity-50 transition active:scale-95"
          title="Kích hoạt tính giá tự động từ số đo kỹ thuật chuẩn khảo sát"
        >
          {isPending ? (
            <>
              <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              <span>Đang tính giá...</span>
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                />
              </svg>
              <span>{buttonLabel}</span>
            </>
          )}
        </button>

        {result?.status === 'CALCULATED' && (
          <Link
            href="/quotations"
            className="text-[11px] text-blue-400 hover:text-blue-300 underline font-medium"
          >
            Xem bảng báo giá &rarr;
          </Link>
        )}
      </div>

      {/* Result feedback */}
      {result && (
        <div className="text-[11px]">
          {result.status === 'CALCULATED' ? (
            <div className="p-2 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-emerald-300 flex items-center justify-between gap-2">
              <span className="font-medium">
                ✓ Giá dự toán: <strong>{result.amount != null ? Number(result.amount).toLocaleString('vi-VN') + ' đ' : '-'}</strong>
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-800/40 text-emerald-200">
                ĐÃ TÍNH GIÁ
              </span>
            </div>
          ) : result.status === 'NEED_INFO' ? (
            <div className="p-2 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-300 space-y-1">
              <div className="font-semibold flex items-center gap-1">
                <span>⚠️ Cần bổ sung thông tin kỹ thuật</span>
              </div>
              {result.missingFields && result.missingFields.length > 0 && (
                <div className="text-[10px] font-mono text-amber-200">
                  Thiếu: {result.missingFields.join(', ')}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {errorMsg && (
        <div className="p-2 rounded-lg bg-rose-950/40 border border-rose-800/50 text-rose-300 text-[11px]">
          {errorMsg}
        </div>
      )}
    </div>
  );
}
