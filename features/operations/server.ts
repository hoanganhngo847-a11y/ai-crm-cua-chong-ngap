import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthError } from '../../lib/auth/context';
export type OperationsClient = SupabaseClient;
export type OperationsActor = { userId: string; role?: string | null };
const messages: Record<string, string> = {
 RESOURCE_NOT_FOUND: 'Không tìm thấy dữ liệu trong tổ chức.',
 INVALID_STATE_TRANSITION: 'Trạng thái hiện tại không cho phép thao tác này.',
 CONTRACT_NOT_SIGNED: 'Đơn hàng cần hợp đồng đã ký và tệp hợp đồng.',
 PRODUCTION_ALREADY_EXISTS: 'Đơn hàng đã có lệnh sản xuất.',
 INVALID_INPUT: 'Dữ liệu không hợp lệ.',
 INVALID_STORAGE_REF: 'Tài liệu không đúng loại hoặc đường dẫn chuẩn.',
 MISSING_EVIDENCE: 'Cần ảnh hiện trường và biên bản PDF.',
 EVIDENCE_CHANGED: 'Tài liệu đã thay đổi. Vui lòng thử lại.',
 STORAGE_OBJECT_NOT_FOUND: 'Không tìm thấy tệp tài liệu.',
 INSTALLATION_SCHEDULE_ALREADY_EXISTS_WITH_DIFFERENT_PAYLOAD: 'Đơn hàng đã có lịch lắp đặt với thông tin khác.',
};
export class OperationsError extends Error {
 constructor(public code: string) { super(messages[code] || 'Thao tác không thành công. Vui lòng thử lại.'); }
}
export function sanitizeErrorMessage(error: unknown, fallback: string): string {
 if (error instanceof AuthError) throw error;
 return error instanceof OperationsError ? error.message : fallback;
}
export async function operationsRpc(client: OperationsClient, name: string, args: Record<string, unknown>) {
 const { data, error } = await client.rpc(name, args);
 if (error) {
  console.error('[operations]', name, { code: error.code, message: error.message });
  if (error.message === 'PERMISSION_DENIED') throw new AuthError('Bạn không có quyền thực hiện thao tác này.', 403);
  throw new OperationsError(Object.hasOwn(messages, error.message) ? error.message : 'OPERATION_FAILED');
 }
 return data;
}
