/**
 * Voice / Hotline module — Safe public contracts
 *
 * SECURITY INVARIANT: No phone numbers, provider_call_id, or provider
 * secrets in any DTO returned to the browser.
 *
 * See docs/PROJECT_MASTER.md §4, §6, §15 and docs/FOUNDATION_HANDOFF.md §3.
 */

// ---------------------------------------------------------------------------
// Call History DTOs
// ---------------------------------------------------------------------------

/**
 * Lịch sử một cuộc gọi — safe cho browser.
 *
 * BOSS_ADMIN: nhận đầy đủ kể cả hasRecording / transcriptStatus.
 * SALE:       hasRecording và transcriptStatus luôn là null.
 */
export interface CallHistoryItemDTO {
  id: string;
  customerId: string;
  customerName: string;
  customerCode: string;
  direction: 'INBOUND' | 'OUTBOUND';
  /** Operational category — không phải RBAC role. */
  agentType: 'AI' | 'SALE';
  status:
    | 'INITIATED'
    | 'RINGING'
    | 'CONNECTED'
    | 'NO_ANSWER'
    | 'BUSY'
    | 'FAILED'
    | 'COMPLETED';
  startedAt: string; // ISO 8601
  endedAt: string | null;
  durationSeconds: number | null;
  /** null khi SALE không được xem. */
  hasRecording: boolean | null;
  /** null khi SALE không được xem. */
  transcriptStatus: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | null;
}

export interface CallHistoryPageDTO {
  items: CallHistoryItemDTO[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// CallAttempt DTO
// ---------------------------------------------------------------------------

/**
 * Một lần thử trong chu kỳ gọi outbound (tối đa 3 lần).
 * Safe cho browser — không có phone.
 */
export interface CallAttemptDTO {
  id: string;
  contactCycleId: string;
  attemptNo: 1 | 2 | 3;
  scheduledAt: string; // ISO 8601
  calledAt: string | null;
  result: 'PENDING' | 'NO_ANSWER' | 'BUSY' | 'ANSWERED' | 'FAILED' | 'CANCELLED';
  callId: string | null;
}

// ---------------------------------------------------------------------------
// Contact Cycle Status
// ---------------------------------------------------------------------------

/**
 * Trạng thái chu kỳ liên hệ hiện tại của một khách.
 */
export interface ContactCycleStatusDTO {
  /** null nếu chưa có chu kỳ nào. */
  contactCycleId: string | null;
  /** null nếu chưa có attempt nào. */
  currentAttemptNo: number | null;
  /** true khi cả 3 attempt đã kết thúc (ANSWERED/NO_ANSWER/BUSY/FAILED/CANCELLED). */
  isCycleComplete: boolean;
  attempts: CallAttemptDTO[];
  /** customers.stage hiện tại. */
  customerStage: string;
}

// ---------------------------------------------------------------------------
// Server Action Params (browser → server)
// ---------------------------------------------------------------------------

/**
 * Tham số để bắt đầu chu kỳ gọi outbound.
 * Chỉ business identifier — không có phone, không có company_id từ client.
 */
export interface ScheduleCallCycleParams {
  customerId: string;
}

/**
 * Tìm khách để gọi (sale dùng tên hoặc mã).
 */
export interface CustomerSearchParams {
  query: string; // tên hoặc customer_code
  page?: number;
  pageSize?: number;
}

/**
 * Kết quả tìm khách — safe cho SALE (không có phone).
 */
export interface CustomerSearchResultDTO {
  id: string;
  customerCode: string;
  name: string;
  stage: string;
  source: string;
}

export interface CustomerSearchPageDTO {
  items: CustomerSearchResultDTO[];
  total: number;
}

/**
 * Filter cho lịch sử cuộc gọi toàn công ty.
 */
export interface CallHistoryFilters {
  customerId?: string;
  agentType?: 'AI' | 'SALE';
  direction?: 'INBOUND' | 'OUTBOUND';
  status?: string;
  dateFrom?: string; // ISO 8601
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Tham số hủy các attempt đang chờ.
 */
export interface CancelCallCycleParams {
  customerId: string;
  contactCycleId: string;
}
