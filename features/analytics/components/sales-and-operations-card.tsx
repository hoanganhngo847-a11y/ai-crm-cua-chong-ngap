import React from 'react';
import type {
  CallsAnalytics,
  CareAnalytics,
  OrdersAnalytics,
  SurveysAnalytics,
} from '@/shared/contracts/analytics';
import { formatMoneyVnd } from '../utils/date-range';

interface SalesAndOperationsCardProps {
  orders: OrdersAnalytics;
  calls: CallsAnalytics;
  surveys: SurveysAnalytics;
  care: CareAnalytics;
}

export function SalesAndOperationsCard({
  orders,
  calls,
  surveys,
  care,
}: SalesAndOperationsCardProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
      {/* 1. Orders by Status */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <h2 className="text-base font-semibold text-white">Đơn hàng trong Kỳ</h2>
          <div className="text-xs text-slate-400 mt-0.5">
            Tổng tạo mới: <strong className="text-white">{orders.created}</strong> ({formatMoneyVnd(orders.orderValueCreated)})
          </div>
        </div>

        {orders.byStatus.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500">Chưa có đơn hàng trong kỳ</div>
        ) : (
          <div className="space-y-2.5">
            {orders.byStatus.map((item) => (
              <div
                key={item.status}
                className="flex items-center justify-between p-2 rounded-lg bg-slate-950/40 border border-slate-800/60 text-xs"
              >
                <span className="text-slate-300 font-medium">{item.status}</span>
                <span className="font-mono text-white font-semibold">{item.count} đơn</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. Call Center Performance */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <h2 className="text-base font-semibold text-white">Tổng đài Cuộc gọi</h2>
          <div className="text-xs text-slate-400 mt-0.5">
            Tổng số: <strong className="text-white">{calls.totalCalls}</strong> cuộc gọi trong kỳ
          </div>
        </div>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-slate-400">Gọi vào (Inbound):</span>
            <span className="font-mono text-white font-medium">{calls.inboundCalls}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-slate-400">Gọi ra (Outbound):</span>
            <span className="font-mono text-white font-medium">{calls.outboundCalls}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-emerald-400">Kết nối thành công:</span>
            <span className="font-mono text-emerald-400 font-medium">{calls.connectedCalls}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-slate-300">Hoàn tất cuộc gọi:</span>
            <span className="font-mono text-white font-medium">{calls.completedCalls}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-amber-400">Không nhấc máy:</span>
            <span className="font-mono text-amber-400 font-medium">{calls.noAnswerCalls}</span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-red-400">Thất bại / Lỗi mạng:</span>
            <span className="font-mono text-red-400 font-medium">{calls.failedCalls}</span>
          </div>
        </div>
      </div>

      {/* 3. Field Surveys */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <h2 className="text-base font-semibold text-white">Khảo sát Hiện trường</h2>
          <div className="text-xs text-slate-400 mt-0.5">
            Hoàn thành: <strong className="text-emerald-400">{surveys.completedSurveys}</strong> biên bản
          </div>
        </div>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-slate-400">Lịch hẹn đã lên:</span>
            <span className="font-mono text-white font-medium">{surveys.surveyAppointmentsCreated}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-emerald-400">Lịch hoàn thành:</span>
            <span className="font-mono text-emerald-400 font-medium">
              {surveys.surveyAppointmentsCompleted}
            </span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-red-400">Lịch bị hủy:</span>
            <span className="font-mono text-red-400 font-medium">{surveys.surveyAppointmentsCancelled}</span>
          </div>
        </div>
      </div>

      {/* 4. Customer Care (Care) */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="border-b border-slate-800/80 pb-2.5">
          <h2 className="text-base font-semibold text-white">Chăm sóc Khách hàng</h2>
          <div className="text-xs text-slate-400 mt-0.5">
            Chuyển đổi: <strong className="text-purple-400">{care.careConvertedToSale}</strong> đơn hàng
          </div>
        </div>

        <div className="space-y-2 text-xs">
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-slate-400">Tin nhắn/Care đã gửi:</span>
            <span className="font-mono text-white font-medium">{care.careSent}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-slate-300">Đã phát thành công:</span>
            <span className="font-mono text-white font-medium">{care.careDelivered}</span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-slate-800/40">
            <span className="text-blue-400">Khách đã phản hồi:</span>
            <span className="font-mono text-blue-400 font-medium">{care.careResponded}</span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-purple-400 font-semibold">Chốt đơn thành công:</span>
            <span className="font-mono text-purple-400 font-bold">{care.careConvertedToSale}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
