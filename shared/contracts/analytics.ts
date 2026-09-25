/**
 * Analytics Contracts & Semantics (Milestone M9.5A)
 *
 * Strict invariants:
 * 1. Money values are serialized as 2-decimal strings (MoneyDecimal) to prevent floating-point errors.
 * 2. Period metrics strictly respect the [from, to) half-open interval.
 * 3. Finance metrics are a current snapshot ("as of now") from public.finance_summaries and NOT a period series.
 * 4. Aggregate-only: no row-level customer/order IDs, phones, or message content.
 */

export type MoneyDecimal = string;

export interface AnalyticsPeriod {
  from: string; // ISO 8601 UTC timestamptz
  to: string;   // ISO 8601 UTC timestamptz
}

export interface CustomerSourceCount {
  source: string;
  count: number;
}

export interface StageDistributionItem {
  stage: string;
  count: number;
}

export interface StageTransitionItem {
  toStage: string;
  count: number;
}

export interface ResponseSlaAnalytics {
  windowsStarted: number;
  saleResponded: number;
  saleRespondedWithin5m: number;
  saleRespondedAfter5m: number;
  aiResponded: number;
  cancelled: number;
  stillOpen: number;
  avgSaleResponseSeconds: number | null;
  avgAiResponseSeconds: number | null;
  saleWithin5mCount: number;
  resolvedBySaleCount: number;
  complianceRateBasisPoints: number | null; // 0..10000 basis points (e.g. 9500 = 95.00%)
}

export interface CallsAnalytics {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  connectedCalls: number;
  completedCalls: number;
  noAnswerCalls: number;
  failedCalls: number;
}

export interface SurveysAnalytics {
  completedSurveys: number;
  surveyAppointmentsCreated: number;
  surveyAppointmentsCompleted: number;
  surveyAppointmentsCancelled: number;
}

export interface OrderStatusCount {
  status: string;
  count: number;
}

export interface OrdersAnalytics {
  created: number;
  orderValueCreated: MoneyDecimal;
  byStatus: OrderStatusCount[];
}

export interface FinanceSnapshot {
  contractValue: MoneyDecimal;
  collectedAmount: MoneyDecimal;
  receivableAmount: MoneyDecimal;
  completedRevenue: MoneyDecimal;
  snapshotAt: string; // ISO 8601 UTC timestamptz
}

export interface CareAnalytics {
  careSent: number;
  careDelivered: number;
  careResponded: number;
  careConvertedToSale: number;
}

export interface CompanyAnalyticsOverview {
  period: AnalyticsPeriod;
  customers: {
    newCustomers: number;
    bySource: CustomerSourceCount[];
  };
  currentStageDistribution: StageDistributionItem[];
  stageTransitions: StageTransitionItem[];
  responseSla: ResponseSlaAnalytics;
  calls: CallsAnalytics;
  surveys: SurveysAnalytics;
  orders: OrdersAnalytics;
  financeSnapshot: FinanceSnapshot;
  care: CareAnalytics;
}

export interface DailyAnalyticsBucket {
  date: string; // YYYY-MM-DD (UTC day bucket)
  newCustomers: number;
  ordersCreated: number;
  orderValueCreated: MoneyDecimal;
  slaWindowsStarted: number;
  saleWithin5m: number;
  aiResponded: number;
  careConvertedToSale: number;
}

export type CompanyAnalyticsDailySeries = DailyAnalyticsBucket[];
