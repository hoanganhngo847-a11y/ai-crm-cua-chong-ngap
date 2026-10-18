import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '@/lib/auth/context';
import { createAdminClient } from '@/lib/supabase/admin';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { getZaloTransportMode } from '@/features/omnichannel/zalo/zcajs-client';
import {
  sendZcaJsMediaMessage,
  type ZcaJsMediaFilePayload,
} from '@/features/omnichannel/zalo/zcajs-media-client';

export const runtime = 'nodejs';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const ALLOWED_GENERIC_MIME = new Set([
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
]);

function isAllowedMime(mime: string): boolean {
  if (!mime) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix)) || ALLOWED_GENERIC_MIME.has(mime);
}

function sanitizeFilename(name: string, index: number): string {
  const raw = (name || `attachment-${index + 1}`).normalize('NFKC');
  const base = raw.split(/[\\/]/).pop() || `attachment-${index + 1}`;
  const cleaned = base.replace(/[^a-zA-Z0-9._()\- ]+/g, '_').replace(/\.{2,}/g, '.').trim();
  return cleaned.slice(0, 120) || `attachment-${index + 1}`;
}

function reject(status: number, error: string, message: string) {
  return NextResponse.json({ success: false, error, message }, { status });
}

export async function POST(request: NextRequest) {
  try {
    if (getZaloTransportMode() !== 'ZCAJS') {
      return reject(503, 'ZCAJS_TRANSPORT_DISABLED', 'Kênh Zalo cá nhân chưa được bật.');
    }

    const actor = await getActorContext();
    if (!actor || actor.profileStatus !== 'ACTIVE') {
      return reject(401, 'UNAUTHORIZED', 'Yêu cầu đăng nhập để gửi tệp.');
    }
    if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
      return reject(403, 'FORBIDDEN', 'Tài khoản không thuộc tổ chức đang hoạt động.');
    }
    if (actor.role !== APPLICATION_ROLES.SALE && actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
      return reject(403, 'ROLE_FORBIDDEN', 'Tài khoản không có quyền gửi tin nhắn trong Hộp thư.');
    }

    const form = await request.formData();
    const conversationId = String(form.get('conversation_id') || '').trim();
    const caption = String(form.get('caption') || '').trim();
    const files = form.getAll('files').filter((value): value is File => value instanceof File);

    if (!conversationId) {
      return reject(400, 'MISSING_CONVERSATION_ID', 'Thiếu mã cuộc hội thoại.');
    }
    if (files.length === 0) {
      return reject(400, 'MISSING_FILES', 'Hãy chọn ít nhất một ảnh hoặc tệp.');
    }
    if (files.length > MAX_FILES) {
      return reject(413, 'TOO_MANY_FILES', `Mỗi lần gửi tối đa ${MAX_FILES} tệp.`);
    }

    let totalBytes = 0;
    for (const file of files) {
      if (file.size <= 0) {
        return reject(400, 'EMPTY_FILE', 'Có tệp rỗng trong danh sách đính kèm.');
      }
      if (file.size > MAX_FILE_BYTES) {
        return reject(413, 'FILE_TOO_LARGE', 'Mỗi tệp được phép tối đa 10 MB.');
      }
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return reject(413, 'PAYLOAD_TOO_LARGE', 'Tổng dung lượng đính kèm được phép tối đa 20 MB.');
      }
      if (!isAllowedMime(file.type)) {
        return reject(415, 'UNSUPPORTED_FILE_TYPE', `Định dạng tệp ${file.type || 'không xác định'} chưa được hỗ trợ.`);
      }
    }

    const supabase = createAdminClient();
    const { data: conversation, error: conversationError } = await supabase
      .from('conversations')
      .select('id, company_id, customer_id, channel, external_conversation_id')
      .eq('id', conversationId)
      .eq('company_id', actor.companyId)
      .maybeSingle();

    if (conversationError) {
      console.error('[ZCAJS media] conversation lookup failed:', conversationError.message);
      return reject(500, 'DATABASE_ERROR', 'Không kiểm tra được cuộc hội thoại.');
    }
    if (!conversation) {
      return reject(404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy cuộc hội thoại hoặc hội thoại không thuộc tổ chức này.');
    }
    if (String(conversation.channel || '').toUpperCase() !== 'ZALO') {
      return reject(400, 'CHANNEL_NOT_SUPPORTED', 'Gửi ảnh/tệp theo cách này hiện chỉ hỗ trợ hội thoại Zalo.');
    }

    const recipientZaloId = String(conversation.external_conversation_id || '').trim();
    if (!recipientZaloId) {
      return reject(409, 'MISSING_ZALO_RECIPIENT', 'Cuộc hội thoại chưa có mã người nhận Zalo hợp lệ.');
    }

    const payloadFiles: ZcaJsMediaFilePayload[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const buffer = Buffer.from(await file.arrayBuffer());
      payloadFiles.push({
        name: sanitizeFilename(file.name, index),
        mimeType: file.type || 'application/octet-stream',
        dataBase64: buffer.toString('base64'),
      });
    }

    const result = await sendZcaJsMediaMessage(
      actor.companyId,
      recipientZaloId,
      caption,
      payloadFiles
    );

    if (result.outcome === 'ACCEPTED') {
      return NextResponse.json({
        success: true,
        data: {
          conversation_id: conversationId,
          provider_message_ids: result.providerMessageIds || [],
          accepted_at: new Date().toISOString(),
        },
        message: 'Zalo đã tiếp nhận ảnh/tệp. Hộp thư sẽ đồng bộ bản tin chính thức ngay sau đó.',
      });
    }

    if (result.outcome === 'REJECTED') {
      return reject(
        502,
        result.errorCode || 'ZCAJS_MEDIA_REJECTED',
        result.errorMessage || 'Zalo từ chối ảnh/tệp.'
      );
    }

    return reject(
      503,
      result.errorCode || 'ZCAJS_MEDIA_UNCERTAIN',
      'Chưa xác định được Zalo đã nhận ảnh/tệp hay chưa. Hệ thống không tự động gửi lại để tránh gửi trùng.'
    );
  } catch (error: unknown) {
    console.error('[ZCAJS media] send failed:', error instanceof Error ? error.message : 'unknown error');
    return reject(500, 'INTERNAL_ERROR', 'Không thể gửi ảnh/tệp lúc này.');
  }
}
