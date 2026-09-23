import React from 'react';
import type { CompanyAnalyticsOverview } from '@/shared/contracts/analytics';
import { formatBasisPoints, formatMoneyVnd } from '../utils/date-range';

interface KpiHighlightsProps {
  overview: CompanyAnalyticsOverview;
}

export function KpiHighlights({ overview }: KpiHighlightsProps) {
  const compliance = overview.responseSla.complianceRateBasisPoints;
  const complianceText = formatBasisPoints(compliance);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {/* 1. New Customers */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl relative overflow-hidden">
        <div className="text-xs font-medium text-slate-400">Khách hàng mới</div>
        <div className="text-2xl font-bold text-white mt-1">
          {overview.customers.newCustomers.toLocaleString('vi-VN')}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400" />
          Trong kỳ lọc
        </div>
      </div>

      {/* 2. Orders Created */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl relative overflow-hidden">
        <div className="text-xs font-medium text-slate-400">Đơn hàng mới</div>
        <div className="text-2xl font-bold text-white mt-1">
          {overview.orders.created.toLocaleString('vi-VN')}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400" />
          Đã tạo trong kỳ
        </div>
      </div>

      {/* 3. Order Value Created */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl relative overflow-hidden">
        <div className="text-xs font-medium text-slate-400">Giá trị đơn phát sinh</div>
        <div className="text-xl font-bold text-emerald-400 mt-1 truncate" title={overview.orders.orderValueCreated}>
          {formatMoneyVnd(overview.orders.orderValueCreated)}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
          Tổng final_amount
        </div>
      </div>

      {/* 4. SLA Compliance */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl relative overflow-hidden">
        <div className="text-xs font-medium text-slate-400">Tuân thủ SLA 5p</div>
        <div
          className={`text-2xl font-bold mt-1 ${
            compliance !== null && compliance >= 9000
              ? 'text-emerald-400'
              : compliance !== null && compliance >= 7500
              ? 'text-amber-400'
              : 'text-red-400'
          }`}
        >
          {complianceText}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-400" />
          {overview.responseSla.windowsStarted} cửa sổ mở
        </div>
      </div>

      {/* 5. Completed Surveys */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl relative overflow-hidden">
        <div className="text-xs font-medium text-slate-400">Khảo sát hoàn thành</div>
        <div className="text-2xl font-bold text-white mt-1">
          {overview.surveys.completedSurveys.toLocaleString('vi-VN')}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
          Hiện trường
        </div>
      </div>

      {/* 6. Care Converted to Sale */}
      <div className="p-4 bg-slate-900 border border-slate-800 rounded-xl relative overflow-hidden">
        <div className="text-xs font-medium text-slate-400">CSKH chuyển đổi</div>
        <div className="text-2xl font-bold text-purple-400 mt-1">
          {overview.care.careConvertedToSale.toLocaleString('vi-VN')}
        </div>
        <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-400" />
          {overview.care.careResponded} đã phản hồi
        </div>
      </div>
    </div>
  );
}
