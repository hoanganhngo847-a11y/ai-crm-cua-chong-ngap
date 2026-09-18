import { maskPhone } from '../services/customer.service';

/**
 * Regex nhận diện số điện thoại di động Việt Nam:
 * - Đầu số nội địa 03x, 05x, 07x, 08x, 09x (10 chữ số)
 * - Đầu số quốc tế +84 / 84 (11-12 ký tự)
 * - Hỗ trợ các ký tự phân cách thông dụng (dấu cách, dấu gạch ngang, dấu chấm)
 */
export const VIETNAMESE_PHONE_REGEX = /(?:\+?84|0)(?:3|5|7|8|9)(?:[.\-\s]?\d){8}\b/g;

/**
 * Làm sạch văn bản: Phát hiện và che toàn bộ số điện thoại xuất hiện trong văn bản
 * (tin nhắn chat, mô tả dòng thời gian, ghi chú...), phục vụ bảo vệ dữ liệu Zero-Phone cho vai trò SALE.
 *
 * Ví dụ:
 * - "Alo số tôi 0912345678" -> "Alo số tôi 09******78"
 * - "Số chị là 0934567890 nhé." -> "Số chị là 09******90 nhé."
 * - "Gọi lại +84987654321 nhé" -> "Gọi lại 09******21 nhé"
 */
export function sanitizePhoneInText(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') {
    return text || '';
  }

  return text.replace(VIETNAMESE_PHONE_REGEX, (matched) => maskPhone(matched));
}
