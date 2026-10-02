'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import ScheduleSurveyModal from '../../survey/components/ScheduleSurveyModal';
import CalculatePriceFromSurveyButton from '../../pricing/components/calculate-price-from-survey-button';

interface CustomerSurveyCardProps {
  customerId: string;
  customerName: string;
  customerAddress?: string;
  userRole?: string | null;
  appointments: Array<{
    id: string;
    type: string;
    status: string;
    address: string;
    start_time: string;
    created_at: string;
  }>;
  surveys: Array<{
    id: string;
    appointment_id: string;
    measurements?: {
      clear_width_mm?: number;
      barrier_height_mm?: number;
      anticipated_flood_height_mm?: number;
      gate_type?: string;
      mounting_method?: string;
    };
    completed_at: string;
    created_at?: string;
  }>;
  calculations: Array<{
    id: string;
    survey_id?: string | null;
    amount: number | null;
    status: string;
    missing_fields: string[] | null;
    created_at: string;
  }>;
}

export default function CustomerSurveyCard({
  customerId,
  customerName,
  customerAddress = '',
  userRole = '',
  appointments = [],
  surveys = [],
  calculations = [],
}: CustomerSurveyCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const isAuthorized = userRole === 'BOSS_ADMIN' || userRole === 'SALE';

  // Latest appointment
  const latestAppointment = appointments.length > 0 ? appointments[0] : null;
  // Latest survey
  const latestSurvey = surveys.length > 0 ? surveys[0] : null;
  // Latest calculation matching latest survey (or any calculation for this customer)
  const latestCalculation =
    calculations.find((c) => latestSurvey && c.survey_id === latestSurvey.id) ||
    (calculations.length > 0 ? calculations[0] : null);

  return (
    <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-400 flex items-center justify-center">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
              />
            </svg>
          </div>
          <h4 className="font-bold text-white text-xs uppercase tracking-wider">
            Khảo Sát &amp; Tính Giá
          </h4>
        </div>

        {isAuthorized && (
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 hover:text-white text-xs font-semibold transition"
          >
            + Lên lịch khảo sát
          </button>
        )}
      </div>

      {/* Content depending on pipeline stage */}
      {surveys.length > 0 ? (
        <div className="space-y-3 text-xs">
          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Khảo sát hiện trường:</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-950/80 border border-emerald-800 text-emerald-300">
                ĐÃ HOÀN TẤT
              </span>
            </div>

            {latestSurvey?.measurements && (
              <div className="grid grid-cols-2 gap-2 text-slate-300 pt-1">
                <div>
                  <span className="text-slate-500 block text-[10px]">Khẩu độ lọt lòng:</span>
                  <span className="font-mono font-bold text-white">
                    {latestSurvey.measurements.clear_width_mm != null ? `${latestSurvey.measurements.clear_width_mm} mm` : '—'}
                    {latestSurvey.measurements.clear_width_mm != null && (
                      <span className="text-slate-400 font-normal">
                        {' '}
                        ({(latestSurvey.measurements.clear_width_mm / 1000).toFixed(2)} m)
                      </span>
                    )}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Chiều cao chắn ngập:</span>
                  <span className="font-mono font-bold text-white">
                    {latestSurvey.measurements.barrier_height_mm != null ? `${latestSurvey.measurements.barrier_height_mm} mm` : '—'}
                    {latestSurvey.measurements.barrier_height_mm != null && (
                      <span className="text-slate-400 font-normal">
                        {' '}
                        ({(latestSurvey.measurements.barrier_height_mm / 1000).toFixed(2)} m)
                      </span>
                    )}
                  </span>
                </div>
              </div>
            )}

            <div className="text-[10px] text-slate-500 pt-1">
              Thời gian hoàn tất: {new Date(latestSurvey!.completed_at).toLocaleString('vi-VN')}
            </div>
          </div>

          {/* Pricing Trigger Section */}
          <div className="p-3 rounded-xl bg-slate-950/40 border border-slate-800/60 space-y-2">
            <div className="text-slate-300 font-semibold text-xs">Tính giá kỹ thuật:</div>

            {latestCalculation ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">Trạng thái:</span>
                  <span
                    className={`font-semibold ${
                      latestCalculation.status === 'CALCULATED'
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                    }`}
                  >
                    {latestCalculation.status === 'CALCULATED' ? 'ĐÃ TÍNH GIÁ' : 'CẦN THÔNG TIN'}
                  </span>
                </div>

                {latestCalculation.amount != null && (
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Số tiền dự toán:</span>
                    <span className="font-mono font-bold text-emerald-400 text-sm">
                      {Number(latestCalculation.amount).toLocaleString('vi-VN')} đ
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-1 border-t border-slate-800">
                  <Link
                    href="/quotations"
                    className="text-[11px] text-blue-400 hover:text-blue-300 underline font-medium"
                  >
                    Xem bảng báo giá &rarr;
                  </Link>

                  {isAuthorized && (
                    <CalculatePriceFromSurveyButton
                      surveyId={latestSurvey!.id}
                      userRole={userRole}
                      buttonLabel="Tính lại giá"
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-slate-400">
                  Khảo sát đã sẵn sàng dữ liệu. Kích hoạt tính giá tự động theo biểu giá chính sách:
                </p>
                {isAuthorized && (
                  <CalculatePriceFromSurveyButton
                    surveyId={latestSurvey!.id}
                    userRole={userRole}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      ) : latestAppointment ? (
        <div className="space-y-2.5 text-xs text-slate-300">
          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Lịch khảo sát:</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-950/80 border border-blue-800 text-blue-300">
                {latestAppointment.status}
              </span>
            </div>
            <div className="text-[11px] text-slate-300">
              Thời gian: <strong>{new Date(latestAppointment.start_time).toLocaleString('vi-VN')}</strong>
            </div>
            <div className="text-[11px] text-slate-400">
              Địa chỉ: {latestAppointment.address}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800/60 text-center space-y-2">
          <p className="text-xs text-slate-400">
            Chưa có lịch khảo sát hiện trường cho khách hàng này.
          </p>
          {isAuthorized && (
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition"
            >
              Lên lịch khảo sát ngay
            </button>
          )}
        </div>
      )}

      {/* Schedule Survey Modal */}
      <ScheduleSurveyModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        customerId={customerId}
        customerName={customerName}
        defaultAddress={customerAddress}
        onSuccess={() => {
          // Window reload or route refresh
          window.location.reload();
        }}
      />
    </div>
  );
}
