import { maskPhone } from '../services/customer.service';

/**
 * Regex nhận diện số điện thoại Việt Nam có cấu trúc hợp lệ:
 * - Di động: 032-039, 052/055/056/058/059, 070/076-079, 081-089, 090-094/096-099
 * - Số bàn: đầu 02, 10-11 chữ số dạng nội địa
 * - Hỗ trợ 0, 84, +84 và các dấu phân cách thông dụng.
 *
 * Chuỗi số sai đầu số/thiếu số không bị che để Sale/AI có thể nhận ra và xin lại số đúng.
 */
export const VIETNAMESE_PHONE_REGEX =
  /(?:\+?84|0)(?:(?:3[2-9]|5[25689]|7[06789]|8[1-9]|9[0-46-9])(?:[.\-\s]?\d){7}|2(?:[.\-\s]?\d){8,9})\b/g;

/**
 * Làm sạch văn bản: chỉ che số điện thoại Việt Nam hợp lệ xuất hiện trong văn bản.
 *
 * Ví dụ:
 * - "Alo số tôi 0912345678" -> "Alo số tôi 09******78"
 * - "Số chị là 0934567890 nhé." -> "Số chị là 09******90 nhé."
 * - "Gọi lại +84987654321 nhé" -> "Gọi lại 09******21 nhé"
 * - "SĐT 09123" -> giữ nguyên để người xử lý biết số chưa hợp lệ.
 */
export function sanitizePhoneInText(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') {
    return text || '';
  }

  const normalized = text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');

  return normalized.replace(VIETNAMESE_PHONE_REGEX, (matched) => maskPhone(matched));
}
