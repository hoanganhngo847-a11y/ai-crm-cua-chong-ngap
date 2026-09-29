import React from 'react';
import type { ResponseSlaAnalytics } from '@/shared/contracts/analytics';
import { formatBasisPoints, formatSeconds } from '../utils/date-range';

interface SlaPerformanceCardProps {
  sla: ResponseSlaAnalytics;
}

export function SlaPerformanceCard({ sla }: SlaPerformanceCardProps) {
  const compliance = sla.complianceRateBasisPoints;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div>
          <h2 className="text-base font-semibold text-white">Cam kết SLA Phản hồi 5 Phút</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Theo dõi tốc độ nhân viên Sale và khả năng cứu nguy tự động của AI
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Tỷ lệ tuân thủ:</span>
          <span
            className={`text-sm font-bold font-mono px-2 py-0.5 rounded ${
              compliance !== null && compliance >= 9000
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : compliance !== null && compliance >= 7500
                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}
          >
            {formatBasisPoints(compliance)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Total Windows */}
        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-[11px] text-slate-400">Cửa sổ SLA mở</div>
          <div className="text-lg font-bold text-white mt-1">{sla.windowsStarted}</div>
        </div>

        {/* Sale within 5m */}
        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-[11px] text-emerald-400 font-medium">Sale ≤ 5 phút</div>
          <div className="text-lg font-bold text-emerald-400 mt-1">{sla.saleRespondedWithin5m}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Đạt chuẩn cam kết</div>
        </div>

        {/* Sale after 5m */}
        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-[11px] text-amber-400 font-medium">Sale trễ &gt; 5 phút</div>
          <div className="text-lg font-bold text-amber-400 mt-1">{sla.saleRespondedAfter5m}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Vượt ngưỡng 5m</div>
        </div>

        {/* AI Responded */}
        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-[11px] text-purple-400 font-medium">AI cứu SLA</div>
          <div className="text-lg font-bold text-purple-400 mt-1">{sla.aiResponded}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Phản hồi tự động</div>
        </div>

        {/* Still Open */}
        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-[11px] text-blue-400 font-medium">Đang mở (chờ)</div>
          <div className="text-lg font-bold text-blue-400 mt-1">{sla.stillOpen}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Chưa chốt phiên</div>
        </div>

        {/* Cancelled */}
        <div className="p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg">
          <div className="text-[11px] text-slate-500">Đã hủy</div>
          <div className="text-lg font-bold text-slate-400 mt-1">{sla.cancelled}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">Cửa sổ hủy</div>
        </div>
      </div>

      {/* Response Speed Averages */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
        <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/40 border border-slate-800/60">
          <div className="text-xs text-slate-400">Thời gian Sale phản hồi trung bình:</div>
          <div className="text-sm font-semibold text-white font-mono">
            {formatSeconds(sla.avgSaleResponseSeconds)}
          </div>
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg bg-slate-950/40 border border-slate-800/60">
          <div className="text-xs text-slate-400">Thời gian AI phản hồi trung bình:</div>
          <div className="text-sm font-semibold text-purple-400 font-mono">
            {formatSeconds(sla.avgAiResponseSeconds)}
          </div>
        </div>
      </div>
    </div>
  );
}
