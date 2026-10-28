/**
 * Chuẩn hóa tiếng Việt để so khớp tín hiệu:
 * - Bỏ dấu (NFD + combining marks), đ/Đ -> d/D
 * - Chữ thường, bỏ ký tự đặc biệt, gộp khoảng trắng
 *
 * Đầu ra là chuỗi ASCII để lexicon không phải chứa nhiều biến thể dấu.
 */
export function normalizeVietnamese(input: string): string {
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kiểm tra một cụm từ đã chuẩn hóa có xuất hiện như một từ/cụm từ trọn vẹn.
 * Tránh khớp nhầm "giá" trong "giá như" hoặc "ký" trong "ký gửi".
 */
export function containsNormalizedPhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const normalizedNeedle = normalizeVietnamese(needle);
  if (!normalizedNeedle) return false;
  return ` ${haystack} `.includes(` ${normalizedNeedle} `);
}

/**
 * Tìm vị trí của cụm từ trong chuỗi đã chuẩn hóa.
 */
export function findNormalizedPhrase(haystack: string, needle: string): number {
  if (!haystack || !needle) return -1;
  const normalizedNeedle = normalizeVietnamese(needle);
  if (!normalizedNeedle) return -1;
  const padded = ` ${haystack} `;
  const idx = padded.indexOf(` ${normalizedNeedle} `);
  return idx < 0 ? -1 : idx;
}

/**
 * Lấy câu gốc chứa một đoạn khớp (dựa trên nội dung gốc, không phải chuỗi đã bỏ dấu).
 * Dùng để trích dẫn nguyên văn, tránh bịa evidence.
 */
export function extractSentenceContaining(original: string, normalizedNeedle: string): string {
  if (!original) return '';
  const sentences = original
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const needle = normalizeVietnamese(normalizedNeedle);
  for (const sentence of sentences) {
    if (containsNormalizedPhrase(normalizeVietnamese(sentence), needle)) {
      return sentence.length > 500 ? `${sentence.slice(0, 497)}...` : sentence;
    }
  }

  const normalizedOriginal = normalizeVietnamese(original);
  if (containsNormalizedPhrase(normalizedOriginal, needle)) {
    const compact = original.trim();
    return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
  }

  return '';
}

/**
 * Phát hiện phủ định / giả định / tương lai gần một tín hiệu.
 * Cửa sổ 6 token trước tín hiệu là đủ cho các câu tư vấn thường gặp.
 */
const NEGATION_MARKERS = [
  'khong',
  'chua',
  'chang',
  'ko',
  'k',
  'khong he',
  'khong phai',
  'khong can',
  'khong muon',
  'chua can',
  'chua muon',
  'chua co',
  'khong co',
];

const HYPOTHETICAL_MARKERS = [
  'neu',
  'neu nhu',
  'gia su',
  'trong truong hop',
  'co the',
  'dang can nhac',
  'dang suy nghi',
  'chac',
  'khong chac',
  'dinh',
  'du dinh',
  'tinh',
];

const FUTURE_MARKERS = ['se', 'sap', 'dinh', 'du dinh', 'chuan bi', 'sap toi', 'thang sau', 'tuan sau'];

export interface SignalContext {
  negated: boolean;
  hypothetical: boolean;
  future: boolean;
  otherProvider: boolean;
  otherProviderChosen: boolean;
}

export function detectSignalContext(normalizedText: string, signalIndex: number): SignalContext {
  const before = normalizedText.slice(Math.max(0, signalIndex - 60), signalIndex);
  const tokens = before.split(/\s+/).filter(Boolean).slice(-8);
  const window = tokens.join(' ');

  const negated = NEGATION_MARKERS.some((marker) => ` ${window} `.includes(` ${marker} `));
  const hypothetical = HYPOTHETICAL_MARKERS.some((marker) => ` ${window} `.includes(` ${marker} `));
  const future = FUTURE_MARKERS.some((marker) => ` ${window} `.includes(` ${marker} `));

  const otherProvider =
    /\b(ben khac|cong ty khac|nha cung cap khac|doi thu|hang khac|cua hang khac|ben a|ben b)\b/.test(
      normalizedText
    );
  const otherProviderChosen =
    /\b(da chon|chon|quyet dinh|da ky|ky hop dong|ky voi|lam voi|mua cua|hop tac voi)\b.{0,40}\b(ben khac|cong ty khac|nha cung cap khac|doi thu|hang khac|cua hang khac)\b/.test(
      normalizedText
    );

  return { negated, hypothetical, future, otherProvider, otherProviderChosen };
}
