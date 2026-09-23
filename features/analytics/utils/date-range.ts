/**
 * Date Range & Parameter Validation Utilities for Analytics Dashboard (Milestone M9.5B)
 *
 * Rules:
 * 1. Strictly UTC calendar date calculations.
 * 2. UI inputs 'from' and 'to' are YYYY-MM-DD strings.
 * 3. 'to' in the UI is inclusive.
 * 4. Server converts 'to' into RPC exclusive boundary [p_from, p_to):
 *    e.g. from = 2026-09-01, to = 2026-09-30
 *         p_from = 2026-09-01T00:00:00.000Z
 *         p_to   = 2026-10-01T00:00:00.000Z
 * 5. Strict calendar date validation (reject 2026-02-30, abc, 01/09/2026).
 * 6. Constraints: from <= to, range <= 366 calendar days.
 * 7. Invalid queries fail safe by falling back to the 30-day UTC default without crashing.
 */

export interface DateRangeResolution {
  fromStr: string;         // YYYY-MM-DD (inclusive UI)
  toStr: string;           // YYYY-MM-DD (inclusive UI)
  rpcFrom: string;         // ISO 8601 UTC timestamptz (inclusive)
  rpcTo: string;           // ISO 8601 UTC timestamptz (exclusive)
  isDefault: boolean;
  validationError: string | null;
  totalDays: number;
}

export interface PresetRange {
  label: string;
  days: number;
  fromStr: string;
  toStr: string;
}

/**
 * Validates that a string strictly adheres to YYYY-MM-DD and corresponds to an actual
 * calendar date in Gregorian calendar (e.g. 2026-02-30 is invalid).
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!dateStr || typeof dateStr !== 'string') {
    return false;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return false;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  if (year < 1970 || year > 2100) {
    return false;
  }

  if (month < 1 || month > 12) {
    return false;
  }

  // Construct UTC date and verify that year, month, day match exactly (no rollover)
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

/**
 * Formats a Date instance as YYYY-MM-DD using UTC date components.
 */
export function formatUtcDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Generates the default 30-day inclusive range ending on today (UTC).
 * E.g. if today UTC is 2026-09-23:
 * from = 2026-08-25
 * to   = 2026-09-23
 * rpcTo = 2026-09-24T00:00:00.000Z
 */
export function getDefaultDateRange(now = new Date()): DateRangeResolution {
  const toUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const fromUtc = new Date(toUtc.getTime() - 29 * 86400000);

  const fromStr = formatUtcDateString(fromUtc);
  const toStr = formatUtcDateString(toUtc);

  const rpcFrom = `${fromStr}T00:00:00.000Z`;
  const nextDay = new Date(toUtc.getTime() + 86400000);
  const rpcTo = nextDay.toISOString();

  return {
    fromStr,
    toStr,
    rpcFrom,
    rpcTo,
    isDefault: true,
    validationError: null,
    totalDays: 30,
  };
}

/**
 * Computes quick preset ranges (7 days, 30 days, 90 days) ending today (UTC).
 */
export function getPresetRanges(now = new Date()): PresetRange[] {
  const toUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const toStr = formatUtcDateString(toUtc);

  const presets = [
    { label: '7 ngày', days: 7 },
    { label: '30 ngày', days: 30 },
    { label: '90 ngày', days: 90 },
  ];

  return presets.map((p) => {
    const fromUtc = new Date(toUtc.getTime() - (p.days - 1) * 86400000);
    return {
      label: p.label,
      days: p.days,
      fromStr: formatUtcDateString(fromUtc),
      toStr,
    };
  });
}

/**
 * Resolves and validates query parameters `from` and `to`.
 * Falls back safely to default 30-day range if parameters are invalid.
 */
export function resolveDateRange(
  fromParam?: string | null,
  toParam?: string | null,
  now = new Date()
): DateRangeResolution {
  const defaultRange = getDefaultDateRange(now);

  // If neither parameter provided, use default
  if (!fromParam && !toParam) {
    return defaultRange;
  }

  // If only one is provided, fail validation and fallback
  if (!fromParam || !toParam) {
    return {
      ...defaultRange,
      validationError:
        'Vui lòng cung cấp cả ngày bắt đầu (Từ ngày) và ngày kết thúc (Đến ngày). Đã tự động dùng 30 ngày gần nhất.',
    };
  }

  const cleanFrom = fromParam.trim();
  const cleanTo = toParam.trim();

  // Validate strict calendar dates
  if (!isValidCalendarDate(cleanFrom) || !isValidCalendarDate(cleanTo)) {
    return {
      ...defaultRange,
      validationError:
        'Định dạng ngày không hợp lệ. Vui lòng nhập ngày thực tế theo chuẩn YYYY-MM-DD. Đã tự động dùng 30 ngày gần nhất.',
    };
  }

  const [fromY, fromM, fromD] = cleanFrom.split('-').map(Number);
  const [toY, toM, toD] = cleanTo.split('-').map(Number);

  const fromTime = Date.UTC(fromY, fromM - 1, fromD);
  const toTime = Date.UTC(toY, toM - 1, toD);

  // Constraint: from <= to
  if (fromTime > toTime) {
    return {
      ...defaultRange,
      validationError:
        'Ngày bắt đầu (Từ ngày) không được lớn hơn ngày kết thúc (Đến ngày). Đã tự động dùng 30 ngày gần nhất.',
    };
  }

  // Constraint: inclusive UI range <= 366 days
  const totalDays = Math.round((toTime - fromTime) / 86400000) + 1;
  if (totalDays > 366) {
    return {
      ...defaultRange,
      validationError: `Khoảng thời gian tra cứu không được vượt quá 366 ngày (khoảng đã chọn: ${totalDays} ngày). Đã tự động dùng 30 ngày gần nhất.`,
    };
  }

  // Calculate inclusive rpcFrom and exclusive rpcTo
  const rpcFrom = `${cleanFrom}T00:00:00.000Z`;
  const nextDay = new Date(Date.UTC(toY, toM - 1, toD + 1));
  const rpcTo = nextDay.toISOString();

  return {
    fromStr: cleanFrom,
    toStr: cleanTo,
    rpcFrom,
    rpcTo,
    isDefault: false,
    validationError: null,
    totalDays,
  };
}

/**
 * Formats a MoneyDecimal string (e.g. "40000000.00") into Vietnamese currency format.
 * Preserves decimal accuracy and handles empty/zero values gracefully.
 */
export function formatMoneyVnd(amount: string | null | undefined): string {
  if (!amount || typeof amount !== 'string') {
    return '0 ₫';
  }

  const [intPart] = amount.split('.');
  const num = parseInt(intPart, 10);
  if (Number.isNaN(num)) {
    return '0 ₫';
  }

  return `${num.toLocaleString('vi-VN')} ₫`;
}

/**
 * Formats duration in seconds to a human-readable Vietnamese string.
 */
export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return '—';
  }

  if (seconds < 60) {
    return `${Math.round(seconds)} giây`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSecs = Math.round(seconds % 60);

  if (remainingSecs === 0) {
    return `${minutes} phút`;
  }

  return `${minutes} phút ${remainingSecs}s`;
}

/**
 * Formats basis points (e.g. 9500 -> 95.00% or 95%) or ratio into percentage string.
 */
export function formatBasisPoints(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined || Number.isNaN(basisPoints)) {
    return '—';
  }

  const percent = basisPoints / 100;
  return `${percent.toFixed(1)}%`;
}
