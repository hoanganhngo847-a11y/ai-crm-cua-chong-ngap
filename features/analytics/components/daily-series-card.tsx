import React from 'react';
import type { CompanyAnalyticsDailySeries } from '@/shared/contracts/analytics';
import { formatMoneyVnd } from '../utils/date-range';

interface DailySeriesCardProps {
  series: CompanyAnalyticsDailySeries;
}

export function DailySeriesCard({ series }: DailySeriesCardProps) {
  // Compute max orders / max customers for responsive activity bars
  const maxCustomers = Math.max(1, ...series.map((d) => d.newCustomers));
  const maxOrders = Math.max(1, ...series.map((d) => d.ordersCreated));

  // Sort descending by date for recent-first table view
  const sortedSeries = [...series].reverse();

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
        <div>
          <h2 className="text-base font-semibold text-white">Diễn biến Hoạt động Hàng ngày</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Dữ liệu phát sinh chia theo từng ngày UTC (Zero-filled các ngày không có hoạt động)
          </p>
        </div>
        <div className="text-xs text-slate-500 font-mono">
          Tổng cộng: <strong className="text-slate-300">{series.length}</strong> ngày
        </div>
      </div>

      {series.length === 0 ? (
        <div className="py-8 text-center text-xs text-slate-500">
          Không có chuỗi dữ liệu hàng ngày cho khoảng thời gian này
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-950/60 text-slate-400 uppercase text-[10px] tracking-wider border-b border-slate-800">
              <tr>
                <th className="py-2.5 px-3">Ngày (UTC)</th>
                <th className="py-2.5 px-3">Khách mới</th>
                <th className="py-2.5 px-3">Đơn tạo</th>
                <th className="py-2.5 px-3">Giá trị đơn</th>
                <th className="py-2.5 px-3">SLA mở</th>
                <th className="py-2.5 px-3">Sale ≤ 5m</th>
                <th className="py-2.5 px-3">AI cứu SLA</th>
                <th className="py-2.5 px-3">CSKH chốt đơn</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40 font-mono">
              {sortedSeries.map((row) => (
                <tr key={row.date} className="hover:bg-slate-800/30 transition">
                  <td className="py-2 px-3 text-slate-200 font-semibold">{row.date}</td>

                  {/* New Customers */}
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <span className={row.newCustomers > 0 ? 'text-blue-400 font-bold' : 'text-slate-600'}>
                        {row.newCustomers}
                      </span>
                      {row.newCustomers > 0 && (
                        <div
                          className="h-1 bg-blue-500/60 rounded-full"
                          style={{ width: `${Math.min(40, (row.newCustomers / maxCustomers) * 40)}px` }}
                        />
                      )}
                    </div>
                  </td>

                  {/* Orders Created */}
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <span className={row.ordersCreated > 0 ? 'text-indigo-400 font-bold' : 'text-slate-600'}>
                        {row.ordersCreated}
                      </span>
                      {row.ordersCreated > 0 && (
                        <div
                          className="h-1 bg-indigo-500/60 rounded-full"
                          style={{ width: `${Math.min(40, (row.ordersCreated / maxOrders) * 40)}px` }}
                        />
                      )}
                    </div>
                  </td>

                  {/* Order Value Created */}
                  <td className="py-2 px-3">
                    <span
                      className={
                        row.orderValueCreated !== '0.00'
                          ? 'text-emerald-400 font-semibold'
                          : 'text-slate-600'
                      }
                      title={row.orderValueCreated}
                    >
                      {formatMoneyVnd(row.orderValueCreated)}
                    </span>
                  </td>

                  {/* SLA Windows */}
                  <td className="py-2 px-3">
                    <span className={row.slaWindowsStarted > 0 ? 'text-slate-300' : 'text-slate-600'}>
                      {row.slaWindowsStarted}
                    </span>
                  </td>

                  {/* Sale <= 5m */}
                  <td className="py-2 px-3">
                    <span className={row.saleWithin5m > 0 ? 'text-emerald-400 font-medium' : 'text-slate-600'}>
                      {row.saleWithin5m}
                    </span>
                  </td>

                  {/* AI Responded */}
                  <td className="py-2 px-3">
                    <span className={row.aiResponded > 0 ? 'text-purple-400 font-medium' : 'text-slate-600'}>
                      {row.aiResponded}
                    </span>
                  </td>

                  {/* Care Converted */}
                  <td className="py-2 px-3">
                    <span
                      className={row.careConvertedToSale > 0 ? 'text-purple-400 font-semibold' : 'text-slate-600'}
                    >
                      {row.careConvertedToSale}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
