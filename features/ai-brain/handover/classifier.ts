import 'server-only';

import {
  HANDOVER_REASONS,
  type HandoverPriority,
  type HandoverReason,
} from './contracts';

const CANONICAL_PRIORITY_MAP: Record<HandoverReason, HandoverPriority> = {
  REFUND_REQUEST: 'URGENT',
  CUSTOMER_COMPLAINT: 'HIGH',
  PAYMENT_ISSUE: 'HIGH',
  LEGAL_OR_POLICY: 'HIGH',
  HIGH_VALUE_LEAD: 'HIGH',
  CUSTOMER_REQUESTED_HUMAN: 'NORMAL',
  PRICE_QUOTATION_REQUIRED: 'NORMAL',
  LOW_CONFIDENCE: 'NORMAL',
  INSUFFICIENT_KNOWLEDGE: 'NORMAL',
  OTHER: 'LOW',
};

export interface ClassifiedHandover {
  readonly reason: HandoverReason;
  readonly priority: HandoverPriority;
}

export function classifyHandoverReason(
  rawReason?: string | null,
  options?: {
    readonly confidence?: number | null;
    readonly priorityOverride?: HandoverPriority;
  }
): ClassifiedHandover {
  if (!rawReason || typeof rawReason !== 'string') {
    const reason: HandoverReason = 'OTHER';
    return {
      reason,
      priority: options?.priorityOverride ?? CANONICAL_PRIORITY_MAP[reason],
    };
  }

  const normalized = rawReason
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, '_');

  // Exact match against canonical reasons
  if (HANDOVER_REASONS.includes(normalized as HandoverReason)) {
    const reason = normalized as HandoverReason;
    return {
      reason,
      priority: options?.priorityOverride ?? CANONICAL_PRIORITY_MAP[reason],
    };
  }

  // Strip diacritics for robust Vietnamese keyword matching
  const unaccented = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Đ/g, 'D');

  // Synonym / keyword matching
  let reason: HandoverReason = 'OTHER';

  if (
    unaccented.includes('REFUND') ||
    unaccented.includes('HOAN_TIEN') ||
    unaccented.includes('TRA_HANG')
  ) {
    reason = 'REFUND_REQUEST';
  } else if (
    unaccented.includes('COMPLAINT') ||
    unaccented.includes('KHIEU_NAI') ||
    unaccented.includes('PHAN_NAN') ||
    unaccented.includes('TUC_GIAN')
  ) {
    reason = 'CUSTOMER_COMPLAINT';
  } else if (
    unaccented.includes('PAYMENT') ||
    unaccented.includes('THANH_TOAN') ||
    unaccented.includes('DISPUTE') ||
    unaccented.includes('CHUYEN_KHOAN')
  ) {
    reason = 'PAYMENT_ISSUE';
  } else if (
    unaccented.includes('LEGAL') ||
    unaccented.includes('PHAP_LY') ||
    unaccented.includes('CHINH_SACH') ||
    unaccented.includes('LUAT') ||
    unaccented.includes('KHOI_KIEN')
  ) {
    reason = 'LEGAL_OR_POLICY';
  } else if (
    unaccented.includes('HIGH_VALUE') ||
    unaccented.includes('VIP') ||
    unaccented.includes('DON_HANG_LON') ||
    unaccented.includes('DU_AN')
  ) {
    reason = 'HIGH_VALUE_LEAD';
  } else if (
    unaccented.includes('PRICE') ||
    unaccented.includes('BAO_GIA') ||
    unaccented.includes('QUOTATION') ||
    unaccented.includes('COST')
  ) {
    reason = 'PRICE_QUOTATION_REQUIRED';
  } else if (
    unaccented.includes('LOW_CONFIDENCE') ||
    unaccented.includes('CONFIDENCE')
  ) {
    reason = 'LOW_CONFIDENCE';
  } else if (
    unaccented.includes('INSUFFICIENT_KNOWLEDGE') ||
    unaccented.includes('KNOWLEDGE') ||
    unaccented.includes('THIEU_THONG_TIN')
  ) {
    reason = 'INSUFFICIENT_KNOWLEDGE';
  } else if (
    unaccented.includes('HUMAN') ||
    unaccented.includes('AGENT') ||
    unaccented.includes('STAFF') ||
    unaccented.includes('NHAN_VIEN') ||
    unaccented.includes('GAP_TU_VAN') ||
    unaccented.includes('HANDOVER')
  ) {
    reason = 'CUSTOMER_REQUESTED_HUMAN';
  }

  return {
    reason,
    priority: options?.priorityOverride ?? CANONICAL_PRIORITY_MAP[reason],
  };
}
