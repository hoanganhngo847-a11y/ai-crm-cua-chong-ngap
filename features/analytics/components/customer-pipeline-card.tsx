import React from 'react';
import type {
  CustomerSourceCount,
  StageDistributionItem,
  StageTransitionItem,
} from '@/shared/contracts/analytics';

interface CustomerPipelineCardProps {
  newCustomers: number;
  bySource: CustomerSourceCount[];
  currentStageDistribution: StageDistributionItem[];
  stageTransitions: StageTransitionItem[];
}

export function CustomerPipelineCard({
  newCustomers,
  bySource,
  currentStageDistribution,
  stageTransitions,
}: CustomerPipelineCardProps) {
  const totalSnapshotCustomers = currentStageDistribution.reduce((acc, curr) => acc + curr.count, 0);
  const totalTransitions = stageTransitions.reduce((acc, curr) => acc + curr.count, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      {/* 1. Lead Sources (By Period) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <h2 className="text-base font-semibold text-white">Nguồn Khách hàng Mới</h2>
          <div className="text-xs text-slate-400 mt-0.5">
            Tổng số: <strong className="text-white">{newCustomers}</strong> khách trong kỳ lọc
          </div>
        </div>

        {bySource.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500">Chưa có khách hàng mới trong kỳ</div>
        ) : (
          <div className="space-y-3">
            {bySource.map((s) => {
              const pct = newCustomers > 0 ? ((s.count / newCustomers) * 100).toFixed(1) : '0';
              return (
                <div key={s.source} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-medium">{s.source || 'Không xác định'}</span>
                    <span className="text-slate-400 font-mono">
                      {s.count} ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, parseFloat(pct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Current Stage Distribution (SNAPSHOT) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Phân bố Giai đoạn Hiện tại</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
              TỨC THỜI
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            Tổng cộng: <strong className="text-white">{totalSnapshotCustomers}</strong> khách hàng trong hệ thống
          </div>
        </div>

        {currentStageDistribution.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500">Không có dữ liệu giai đoạn</div>
        ) : (
          <div className="space-y-3">
            {currentStageDistribution.map((item) => {
              const pct =
                totalSnapshotCustomers > 0
                  ? ((item.count / totalSnapshotCustomers) * 100).toFixed(1)
                  : '0';
              return (
                <div key={item.stage} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-medium">{item.stage}</span>
                    <span className="text-slate-400 font-mono">
                      {item.count} ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-emerald-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, parseFloat(pct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Stage Transitions (PERIOD EVENTS) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Chuyển Giai đoạn trong Kỳ</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
              THEO KỲ
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            Tổng cộng: <strong className="text-white">{totalTransitions}</strong> lượt chuyển trạng thái
          </div>
        </div>

        {stageTransitions.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500">Không có lượt chuyển giai đoạn trong kỳ</div>
        ) : (
          <div className="space-y-3">
            {stageTransitions.map((item) => {
              const pct =
                totalTransitions > 0 ? ((item.count / totalTransitions) * 100).toFixed(1) : '0';
              return (
                <div key={item.toStage} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 font-medium">Chuyển sang: {item.toStage}</span>
                    <span className="text-slate-400 font-mono">
                      {item.count} lượt ({pct}%)
                    </span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, parseFloat(pct))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
