'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import ScheduleSurveyModal from '../../survey/components/ScheduleSurveyModal';
import CalculatePriceFromSurveyButton from '../../pricing/components/calculate-price-from-survey-button';
import { Card, CardHeader, CardTitle, CardContent } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { ClipboardList, Plus, Calendar } from 'lucide-react';

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
  userRole,
  appointments = [],
  surveys = [],
  calculations = [],
}: CustomerSurveyCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const isAuthorized = userRole === 'BOSS_ADMIN' || userRole === 'SALE';

  const latestAppointment = appointments.length > 0 ? appointments[0] : null;
  const latestSurvey = surveys.length > 0 ? surveys[0] : null;
  const latestCalculation =
    calculations.find((c) => latestSurvey && c.survey_id === latestSurvey.id) ||
    (calculations.length > 0 ? calculations[0] : null);

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <CardHeader className="flex items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="w-4 h-4 text-teal-600" />
          <span>Khảo Sát &amp; Tính Giá</span>
        </CardTitle>

        {isAuthorized && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => setIsModalOpen(true)}
            leftIcon={<Plus className="w-3 h-3" />}
          >
            Lên lịch khảo sát
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {surveys.length > 0 ? (
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[var(--text-secondary)] font-medium">Khảo sát hiện trường:</span>
                <Badge variant="success" size="xs">
                  ĐÃ HOÀN TẤT
                </Badge>
              </div>

              {latestSurvey?.measurements && (
                <div className="grid grid-cols-2 gap-2 text-[var(--text-primary)] pt-1">
                  <div>
                    <span className="text-[var(--text-tertiary)] block text-[10px]">Khẩu độ lọt lòng:</span>
                    <span className="font-mono font-semibold text-[var(--text-primary)]">
                      {latestSurvey.measurements.clear_width_mm != null ? `${latestSurvey.measurements.clear_width_mm} mm` : '—'}
                      {latestSurvey.measurements.clear_width_mm != null && (
                        <span className="text-[var(--text-secondary)] font-normal">
                          {' '}
                          ({(latestSurvey.measurements.clear_width_mm / 1000).toFixed(2)} m)
                        </span>
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-[var(--text-tertiary)] block text-[10px]">Chiều cao chắn ngập:</span>
                    <span className="font-mono font-semibold text-[var(--text-primary)]">
                      {latestSurvey.measurements.barrier_height_mm != null ? `${latestSurvey.measurements.barrier_height_mm} mm` : '—'}
                      {latestSurvey.measurements.barrier_height_mm != null && (
                        <span className="text-[var(--text-secondary)] font-normal">
                          {' '}
                          ({(latestSurvey.measurements.barrier_height_mm / 1000).toFixed(2)} m)
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              <div className="text-[10px] text-[var(--text-tertiary)] pt-1">
                Thời gian hoàn tất: {new Date(latestSurvey!.completed_at).toLocaleString('vi-VN')}
              </div>
            </div>

            {/* Pricing Section */}
            <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-2">
              <div className="text-[var(--text-primary)] font-semibold text-xs">Tính giá kỹ thuật:</div>

              {latestCalculation ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[var(--text-secondary)]">Trạng thái:</span>
                    <Badge
                      variant={latestCalculation.status === 'CALCULATED' ? 'success' : 'warning'}
                      size="xs"
                    >
                      {latestCalculation.status === 'CALCULATED' ? 'ĐÃ TÍNH GIÁ' : 'CẦN THÔNG TIN'}
                    </Badge>
                  </div>

                  {latestCalculation.amount != null && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-[var(--text-secondary)]">Giá dự toán:</span>
                      <span className="font-mono font-bold text-base text-[var(--accent)]">
                        {new Intl.NumberFormat('vi-VN', {
                          style: 'currency',
                          currency: 'VND',
                        }).format(latestCalculation.amount)}
                      </span>
                    </div>
                  )}

                  {latestCalculation.missing_fields && latestCalculation.missing_fields.length > 0 && (
                    <div className="text-[11px] text-amber-700 bg-amber-50 p-2 rounded border border-amber-200">
                      Thiếu thông số: {latestCalculation.missing_fields.join(', ')}
                    </div>
                  )}
                </div>
              ) : null}

              {latestSurvey && isAuthorized && (
                <div className="pt-2 border-t border-[var(--border-subtle)]">
                  <CalculatePriceFromSurveyButton surveyId={latestSurvey.id} />
                </div>
              )}
            </div>
          </div>
        ) : latestAppointment ? (
          <div className="p-3 rounded-lg bg-[var(--surface-secondary)] border border-[var(--border-subtle)] space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[var(--text-secondary)] font-medium">Lịch hẹn khảo sát:</span>
              <Badge variant="accent" size="xs">
                {latestAppointment.status}
              </Badge>
            </div>
            <div className="text-[var(--text-primary)] font-medium">
              Thời gian: {new Date(latestAppointment.start_time).toLocaleString('vi-VN')}
            </div>
            {latestAppointment.address && (
              <div className="text-[var(--text-secondary)] text-[11px]">
                Địa chỉ: {latestAppointment.address}
              </div>
            )}
            <div className="pt-2">
              <Link href={`/surveys/${latestAppointment.id}`}>
                <Button variant="outline" size="xs" className="w-full">
                  Nhập số đo khảo sát hiện trường →
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <div className="text-center py-6 text-xs text-[var(--text-tertiary)]">
            <p>Chưa có lịch hẹn khảo sát hiện trường.</p>
            {isAuthorized && (
              <Button
                variant="outline"
                size="xs"
                onClick={() => setIsModalOpen(true)}
                className="mt-2.5"
                leftIcon={<Calendar className="w-3.5 h-3.5" />}
              >
                Đặt lịch khảo sát ngay
              </Button>
            )}
          </div>
        )}
      </CardContent>

      {/* Schedule Survey Modal */}
      {isAuthorized && (
        <ScheduleSurveyModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          customerId={customerId}
          customerName={customerName}
          defaultAddress={customerAddress}
        />
      )}
    </Card>
  );
}
