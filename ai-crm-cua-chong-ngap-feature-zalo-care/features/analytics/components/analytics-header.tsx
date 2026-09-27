import React from 'react';
import type { DateRangeResolution, PresetRange } from '../utils/date-range';

interface AnalyticsHeaderProps {
  actorEmail: string;
  actorRole: string;
  actorAal: string | null;
  companyId: string;
  range: DateRangeResolution;
  presets: PresetRange[];
}

export function AnalyticsHeader({
  actorEmail,
  actorRole,
  actorAal,
  companyId,
  range,
  presets,
}: AnalyticsHeaderProps) {
  return (
    <div className="space-y-4">
      {/* Breadcrumb & Navigation */}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <a href="/admin" className="hover:text-white transition">
          Quản trị hệ thống
        </a>
        <span>/</span>
        <span className="text-blue-400 font-medium">Báo cáo & Thống kê (Analytics)</span>
      </div>

      {/* Main Title & Identity Badge */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-3">
            Báo cáo Quản trị Doanh nghiệp
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono font-normal">
              BOSS_ADMIN ONLY
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Trung tâm dữ liệu tổng hợp hoạt động kinh doanh, SLA phản hồi, vận hành và ảnh chụp tài chính.
          </p>
        </div>

        <div className="flex items-center gap-3 self-start md:self-auto">
          <div className="text-right text-xs">
            <div className="text-slate-300 font-medium">{actorEmail}</div>
            <div className="text-slate-500 font-mono flex items-center justify-end gap-1.5 mt-0.5">
              <span>{actorRole}</span>
              <span>•</span>
              <span className="text-emerald-400 font-semibold">{actorAal?.toUpperCase() || 'AAL2'}</span>
            </div>
          </div>
          <div className="h-8 w-px bg-slate-800" />
          <div className="text-xs text-slate-500 font-mono">
            <div>Tenant:</div>
            <div className="text-slate-400 truncate max-w-[120px]" title={companyId}>
              {companyId.slice(0, 8)}...
            </div>
          </div>
        </div>
      </div>

      {/* UTC Timezone Notice */}
      <div className="flex items-center justify-between p-3 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <span className="text-amber-400 font-bold">ℹ Lưu ý múi giờ:</span>
          <span>
            Dashboard hiện dùng mốc ngày <strong>UTC</strong> vì Company timezone canonical chưa tồn tại.
          </span>
        </div>
        <div className="text-slate-500 font-mono">
          Chu kỳ lọc: [{range.rpcFrom.slice(0, 10)} 00:00Z → {range.rpcTo.slice(0, 10)} 00:00Z)
        </div>
      </div>

      {/* Validation Error Alert (if query params were invalid) */}
      {range.validationError && (
        <div className="p-3.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2.5">
          <span className="font-bold text-amber-400 mt-0.5">⚠</span>
          <div>
            <span className="font-semibold">Cảnh báo tham số ngày:</span> {range.validationError}
          </div>
        </div>
      )}

      {/* Date Filter & Presets Form */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        {/* Presets */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-400 mr-1">Bộ lọc nhanh:</span>
          {presets.map((preset) => {
            const isActive =
              range.fromStr === preset.fromStr && range.toStr === preset.toStr;
            return (
              <a
                key={preset.label}
                href={`/admin/analytics?from=${preset.fromStr}&to=${preset.toStr}`}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-750 hover:text-white border border-slate-700/60'
                }`}
              >
                {preset.label}
              </a>
            );
          })}
        </div>

        {/* Custom Date Form (GET method) */}
        <form method="GET" action="/admin/analytics" className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="analytics-from" className="text-xs text-slate-400">
              Từ ngày:
            </label>
            <input
              id="analytics-from"
              name="from"
              type="date"
              defaultValue={range.fromStr}
              required
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="analytics-to" className="text-xs text-slate-400">
              Đến hết ngày:
            </label>
            <input
              id="analytics-to"
              name="to"
              type="date"
              defaultValue={range.toStr}
              required
              className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <button
            type="submit"
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold transition cursor-pointer"
          >
            Áp dụng
          </button>

          {!range.isDefault && (
            <a
              href="/admin/analytics"
              className="text-xs text-slate-400 hover:text-white underline transition px-1"
            >
              Mặc định
            </a>
          )}
        </form>
      </div>
    </div>
  );
}
