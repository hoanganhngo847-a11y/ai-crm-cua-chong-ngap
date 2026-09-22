/**
 * Types and Interfaces for Zalo Bulk Care & Periodic Scheduling
 * Member 3 (Hùng) - Ownership: features/care/zalo/
 */

/**
 * 4 Target Audience Segments for Zalo Care Campaigns
 */
export const CARE_AUDIENCE_GROUPS = {
  UNREACHABLE_3_TIMES: 'UNREACHABLE_3_TIMES', // Khách gọi 3 lần không nghe
  CONSIDERING: 'CONSIDERING',                 // Đang cân nhắc (đã có giá/thương lượng)
  QUOTED_NOT_CLOSED: 'QUOTED_NOT_CLOSED',     // Đã khảo sát/báo giá chưa chốt
  OLD_CUSTOMER: 'OLD_CUSTOMER',               // Khách cũ đã bàn giao/bảo hành
} as const;

export type CareAudienceGroup =
  (typeof CARE_AUDIENCE_GROUPS)[keyof typeof CARE_AUDIENCE_GROUPS];

export type CareDeliveryStatus =
  | 'PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'RESPONDED'
  | 'CONVERTED_TO_SALE'
  | 'SKIPPED';

export interface CreateCareCampaignParams {
  companyId: string;
  title: string;
  audienceGroup: CareAudienceGroup;
  messageTemplate: string;
  startedAt?: string;
  batchSize?: number;
  delayMsBetweenBatches?: number;
}

export interface CareCampaignDTO {
  id: string;
  companyId: string;
  channel: 'ZALO';
  audienceRule: {
    audienceGroup: CareAudienceGroup;
    title?: string;
  };
  messageTemplate: string;
  startedAt: string;
  sentCount: number;
  deliveredCount: number;
  responseCount: number;
  convertedToSaleCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CareDeliveryDTO {
  id: string;
  companyId: string;
  campaignId: string;
  customerId: string;
  idempotencyKey: string;
  channel: 'ZALO';
  externalMessageRef?: string | null;
  status: CareDeliveryStatus;
  sentAt?: string | null;
  deliveredAt?: string | null;
  respondedAt?: string | null;
  convertedToSaleAt?: string | null;
  createdAt: string;
}

export interface CareScheduleDTO {
  id: string;
  companyId: string;
  customerId: string;
  channel: 'ZALO';
  frequencyMonths: number;
  nextSendAt: string;
  enabled: boolean;
  stopReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignAnalyticsSummary {
  campaignId: string;
  title?: string;
  audienceGroup: CareAudienceGroup;
  sentCount: number;
  deliveredCount: number;
  responseCount: number;
  convertedToSaleCount: number;
  deliveryRatePercent: number;
  responseRatePercent: number;
  conversionRatePercent: number;
  updatedAt: string;
}

export interface AudienceCustomerInfo {
  customerId: string;
  customerName: string;
  customerStage: string;
  zaloUid: string;
}
