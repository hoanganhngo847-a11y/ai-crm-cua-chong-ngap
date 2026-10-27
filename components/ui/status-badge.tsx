'use client';

import React from 'react';
import { Badge, BadgeProps } from './badge';

export interface StatusBadgeProps extends Omit<BadgeProps, 'variant'> {
  status: string;
  label?: string;
  variant?: BadgeProps['variant'];
}

const STAGE_CONFIG: Record<
  string,
  { label: string; variant: BadgeProps['variant'] }
> = {
  LEAD_NEW: { label: 'Khách mới', variant: 'info' },
  KHACH_MOI: { label: 'Khách mới', variant: 'info' },
  CONTACT_CYCLE_1: { label: 'Liên hệ lần 1', variant: 'neutral' },
  CONTACT_CYCLE_2: { label: 'Liên hệ lần 2', variant: 'neutral' },
  CONTACT_CYCLE_3: { label: 'Liên hệ lần 3', variant: 'neutral' },
  UNREACHABLE: { label: 'Không nghe máy', variant: 'warning' },
  ZALO_FRIENDED: { label: 'Đã kết bạn Zalo', variant: 'info' },
  DA_KET_BAN_ZALO: { label: 'Đã kết bạn Zalo', variant: 'info' },
  IN_CARE: { label: 'Đang chăm sóc', variant: 'accent' },
  DANG_CHAM_SOC: { label: 'Đang chăm sóc', variant: 'accent' },
  POTENTIAL_CLOSING: { label: 'Có tiềm năng chốt đơn', variant: 'warning' },
  CO_TIEM_NANG: { label: 'Có tiềm năng chốt đơn', variant: 'warning' },
  NOT_POTENTIAL: { label: 'Chưa có tiềm năng chốt đơn', variant: 'neutral' },
  CHUA_TIEM_NANG: { label: 'Chưa có tiềm năng chốt đơn', variant: 'neutral' },
  NO_DEMAND: { label: 'Không có nhu cầu nghe tư vấn', variant: 'danger' },
  KHONG_NHU_CAU: { label: 'Không có nhu cầu nghe tư vấn', variant: 'danger' },
  CONTRACT_SIGNED: { label: 'Đã ký hợp đồng', variant: 'success' },
  DA_KY_HOP_DONG: { label: 'Đã ký hợp đồng', variant: 'success' },
  DA_KI_HOP_DONG: { label: 'Đã ký hợp đồng', variant: 'success' },
  CARE_NURTURING: { label: 'Đang chăm sóc sau bán', variant: 'success' },
  CHAM_SOC_SAU_BAN: { label: 'Đang chăm sóc sau bán', variant: 'success' },
  SURVEY_REQUESTED: { label: 'Yêu cầu khảo sát', variant: 'info' },
  SURVEY_SCHEDULED: { label: 'Đã hẹn khảo sát', variant: 'accent' },
  SURVEY_COMPLETED: { label: 'Đã khảo sát', variant: 'info' },
  PRICE_CALCULATED: { label: 'Đã lên giá', variant: 'info' },
  NEED_INFO: { label: 'Cần bổ sung tin', variant: 'warning' },
  PRICE_OFFERED: { label: 'Đã báo giá', variant: 'accent' },
  DA_CO_GIA: { label: 'Đã báo giá', variant: 'accent' },
  NEGOTIATING: { label: 'Đang đàm phán', variant: 'warning' },
  DANG_THUONG_LUONG: { label: 'Đang thương lượng', variant: 'warning' },
  ORDER_CREATED: { label: 'Đã tạo đơn', variant: 'success' },
  DEPOSIT_CONFIRMED: { label: 'Đã đặt cọc', variant: 'success' },
  IN_PRODUCTION: { label: 'Đang sản xuất', variant: 'accent' },
  READY_FOR_INSTALL: { label: 'Chờ lắp đặt', variant: 'accent' },
  INSTALLING: { label: 'Đang lắp đặt', variant: 'accent' },
  HANDOVER_COMPLETED: { label: 'Đã nghiệm thu', variant: 'success' },
  WARRANTY_ACTIVE: { label: 'Đang bảo hành', variant: 'success' },
  LOST: { label: 'Mất khách', variant: 'danger' },

  // Call statuses
  COMPLETED: { label: 'Thành công', variant: 'success' },
  MISSED: { label: 'Nhỡ', variant: 'danger' },
  FAILED: { label: 'Thất bại', variant: 'danger' },
  PENDING: { label: 'Đang chờ', variant: 'warning' },
  PROCESSING: { label: 'Đang xử lý', variant: 'accent' },

  // AI & Automation statuses
  ACTIVE: { label: 'Hoạt động', variant: 'success' },
  HEALTHY: { label: 'Khỏe mạnh', variant: 'success' },
  DEGRADED: { label: 'Cảnh báo', variant: 'warning' },
  CRITICAL: { label: 'Nghiêm trọng', variant: 'danger' },
  AI_RESPONDED: { label: 'AI phản hồi', variant: 'ai' },
  HUMAN_TAKEOVER: { label: 'Sale can thiệp', variant: 'warning' },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  label,
  variant,
  className = '',
  ...props
}) => {
  const normalizedKey = (status || '').toUpperCase().trim();
  const config = STAGE_CONFIG[normalizedKey] || {
    label: label || status || 'Chưa xác định',
    variant: variant || 'neutral',
  };

  const finalVariant = variant || config.variant;
  const finalLabel = label || config.label;

  const dotColors: Record<NonNullable<BadgeProps['variant']>, string> = {
    neutral: 'bg-[var(--text-tertiary)]',
    info: 'bg-[var(--info)]',
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    danger: 'bg-[var(--danger)]',
    accent: 'bg-[var(--accent)]',
    ai: 'bg-[var(--ai)]',
  };

  return (
    <Badge
      variant={finalVariant}
      className={`gap-1.5 ${className}`}
      {...props}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[finalVariant || 'neutral']}`}
        aria-hidden="true"
      />
      <span>{finalLabel}</span>
    </Badge>
  );
};
