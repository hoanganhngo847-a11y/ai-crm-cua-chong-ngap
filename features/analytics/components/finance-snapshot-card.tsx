import React from 'react';
import type { FinanceSnapshot } from '@/shared/contracts/analytics';
import { formatMoneyVnd } from '../utils/date-range';

interface FinanceSnapshotCardProps {
  snapshot: FinanceSnapshot;
}

export function FinanceSnapshotCard({ snapshot }: FinanceSnapshotCardProps) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
      {/* Header & Disclaimer */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-white">Ảnh chụp Tài chính Doanh nghiệp</h2>
            <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono font-medium">
              AS OF NOW (TỨC THỜI)
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Số liệu phản ánh toàn bộ trạng thái đơn hàng hiện tại của công ty. Không bị cắt lọc theo chu kỳ ngày ở trên.
          </p>
        </div>

        <div className="text-right text-[11px] text-slate-500 font-mono">
          Thời điểm chụp: <span className="text-slate-400">{snapshot.snapshotAt.replace('T', ' ').slice(0, 19)} UTC</span>
        </div>
      </div>

      {/* 4 Financial Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Contract Value */}
        <div className="p-4 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-xs text-slate-400 font-medium">Tổng giá trị hợp đồng</div>
          <div className="text-xl font-bold text-white mt-1" title={snapshot.contractValue}>
            {formatMoneyVnd(snapshot.contractValue)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            contractValue: {snapshot.contractValue}
          </div>
        </div>

        {/* Collected Amount */}
        <div className="p-4 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-xs text-emerald-400 font-medium">Đã thực thu</div>
          <div className="text-xl font-bold text-emerald-400 mt-1" title={snapshot.collectedAmount}>
            {formatMoneyVnd(snapshot.collectedAmount)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            collectedAmount: {snapshot.collectedAmount}
          </div>
        </div>

        {/* Receivable Amount */}
        <div className="p-4 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-xs text-amber-400 font-medium">Công nợ phải thu</div>
          <div className="text-xl font-bold text-amber-400 mt-1" title={snapshot.receivableAmount}>
            {formatMoneyVnd(snapshot.receivableAmount)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            receivableAmount: {snapshot.receivableAmount}
          </div>
        </div>

        {/* Completed Revenue */}
        <div className="p-4 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-xs text-blue-400 font-medium">Doanh thu đã nghiệm thu</div>
          <div className="text-xl font-bold text-blue-400 mt-1" title={snapshot.completedRevenue}>
            {formatMoneyVnd(snapshot.completedRevenue)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 font-mono">
            completedRevenue: {snapshot.completedRevenue}
          </div>
        </div>
      </div>
    </div>
  );
}
