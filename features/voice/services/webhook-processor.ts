import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAdminClient } from '../../../lib/supabase/admin';
import { ServerAuthError } from '../../../lib/server-auth/errors';
import { normalizeVietnamPhoneToE164 } from '../utils/phone';
import { processRecordingReady } from './media-pipeline';
import {
  markAttemptResult,
} from './call-attempt-scheduler';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payload từ tổng đài — structure phụ thuộc provider */
export interface VoiceWebhookPayload {
  event: string;
  provider_call_id?: string;
  call_id?: string; // internal nếu tổng đài biết
  status?: string;
  ended_at?: string;
  duration?: number; // seconds
  recording_url?: string; // URL phía provider (sẽ được download và lưu nội bộ)
  recording_ref?: string; // đã lưu nội bộ — provider gửi thẳng ref
  from_number?: string; // KHÔNG DÙNG để lookup, chỉ inbound identity
  to_number?: string;
  direction?: 'inbound' | 'outbound';
  company_webhook_token?: string; // routing token (không phải auth)
  recording_id?: string;
  call_status?: string;
  endCallCause?: string;
  answerDuration?: number;
  callCreatedReason?: string;
  project_id?: string | number;
  projectId?: string | number;
  from?: { number?: string; type?: string };
  to?: { number?: string; type?: string };
  intake?: {
    customer_name?: string;
    door_type?: string;
    width_mm?: number;
    height_mm?: number;
    flood_depth_mm?: number;
    opening_count?: number;
    survey_address?: string;
    survey_requested?: boolean;
    preferred_survey_at?: string;
    notes?: string;
  };
  [key: string]: unknown; // provider-specific fields
}

/** Kết quả xử lý webhook */
export interface WebhookProcessResult {
  handled: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Verify signature
// ---------------------------------------------------------------------------

/**
 * Xác thực chữ ký webhook từ tổng đài.
 *
 * Stringee: header X-STRINGEE-SIGNATURE = Base64(HMAC-SHA1(request data, secret)).
 * Viettel: header Authorization = Bearer <token>
 *
 * @returns true nếu hợp lệ
 */
export function verifyWebhookSignature(
  headers: Headers,
  rawBody: string,
  secretOverride?: string,
  providerOverride?: string
): boolean {
  const webhookSecret = secretOverride || process.env.VOICE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    // Nếu chưa cấu hình secret → chỉ cho phép trong dev
    if (process.env.NODE_ENV === 'production') {
      console.error('[webhook-processor] VOICE_WEBHOOK_SECRET chưa được cấu hình trong production.');
      return false;
    }
    console.warn('[webhook-processor] VOICE_WEBHOOK_SECRET chưa cấu hình — bỏ qua verify trong dev.');
    return true;
  }

  // Provider-specific signature verification
  const provider = providerOverride || process.env.VOICE_PROVIDER || 'MANUAL';

  if (provider === 'STRINGEE') {
    const signature = headers.get('x-stringee-signature');
    if (!signature) return false;
    const expected = createHmac('sha1', webhookSecret).update(rawBody).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'base64');
    } catch {
      return false;
    }
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  // Generic: kiểm tra Authorization header = Bearer <secret>
  const authHeader = headers.get('authorization');
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  return token === webhookSecret;
}

/** Convert provider-native Stringee events to the module's stable event contract. */
export function normalizeVoiceWebhookPayload(payload: VoiceWebhookPayload): VoiceWebhookPayload {
  if (payload.event || !payload.call_status) return payload;

  const status = payload.call_status.toLowerCase();
  const isInbound = payload.callCreatedReason
    ? payload.callCreatedReason === 'EXTERNAL_CALL_IN'
    : payload.from?.type === 'external' && payload.to?.type === 'internal';
  let mappedStatus = status;
  if (status === 'answered') mappedStatus = 'answered';
  if (status === 'ended' || status === 'agentended') {
    const cause = (payload.endCallCause || '').toLowerCase();
    mappedStatus = (payload.answerDuration || 0) > 0
      ? 'completed'
      : cause.includes('486') || cause.includes('busy')
        ? 'busy'
        : cause.includes('480') || cause.includes('no answer')
          ? 'no_answer'
          : 'failed';
  }

  return {
    ...payload,
    event: isInbound && ['created', 'started'].includes(status) ? 'call.inbound' : 'call.status_updated',
    provider_call_id: payload.provider_call_id || payload.call_id,
    status: mappedStatus,
    direction: isInbound ? 'inbound' : 'outbound',
    from_number: payload.from_number || payload.from?.number,
    to_number: payload.to_number || payload.to?.number,
    duration: payload.duration,
  };
}

// ---------------------------------------------------------------------------
// Tìm call theo provider_call_id
// ---------------------------------------------------------------------------

async function findCallByProviderCallId(
  providerCallId: string,
  companyId: string,
  provider: 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON'
): Promise<{ id: string; company_id: string; customer_id: string; status: string } | null> {
  const adminClient = createAdminClient();

  const query = adminClient
    .from('calls')
    .select('id, company_id, customer_id, status')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .eq('provider_call_id', providerCallId);

  const { data, error } = await query.maybeSingle();

  if (error) return null;
  return data as { id: string; company_id: string; customer_id: string; status: string } | null;
}

/** Replace the temporary CRM correlation id after Stringee calls the signed answer_url. */
export async function bindStringeeCallId(
  correlationId: string,
  stringeeCallId: string,
  companyId: string
): Promise<boolean> {
  if (!/^crm_[0-9a-f-]{36}$/i.test(correlationId) || !/^call-[A-Za-z0-9-]{8,200}$/.test(stringeeCallId)) {
    return false;
  }
  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('calls')
    .update({ provider_call_id: stringeeCallId })
    .eq('company_id', companyId)
    .eq('provider', 'STRINGEE')
    .eq('provider_call_id', correlationId)
    .select('id')
    .maybeSingle();
  return !error && Boolean(data);
}

// ---------------------------------------------------------------------------
// Xử lý event: call.status_updated / call.completed
// ---------------------------------------------------------------------------

/**
 * Cập nhật trạng thái cuộc gọi sau khi nhận webhook.
 * Nếu kết thúc (COMPLETED/NO_ANSWER/BUSY/FAILED) → cập nhật attempt result.
 *
 * SECURITY: recording_url từ provider KHÔNG được lưu trực tiếp vào DB.
 * Recording phải được download server-side và lưu vào bucket 'call-recordings'.
 * recording_ref = path nội bộ (không phải URL provider).
 */
export async function processCallStatusUpdate(
  payload: VoiceWebhookPayload,
  companyId: string,
  provider: 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON'
): Promise<WebhookProcessResult> {
  const providerCallId = payload.provider_call_id;

  if (!providerCallId) {
    return { handled: false, message: 'provider_call_id missing' };
  }

  const call = await findCallByProviderCallId(providerCallId, companyId, provider);

  if (!call) {
    // Do not log provider correlation IDs; acknowledge races without leaking metadata.
    return { handled: false, message: 'call not found — ignored' };
  }

  const adminClient = createAdminClient();

  // Map provider status sang internal status
  const statusMap: Record<string, string> = {
    created: 'INITIATED',
    started: 'INITIATED',
    answered: 'CONNECTED',
    completed: 'COMPLETED',
    no_answer: 'NO_ANSWER',
    busy: 'BUSY',
    failed: 'FAILED',
    ringing: 'RINGING',
  };

  const rawStatus = (payload.status || '').toLowerCase();
  const newStatus = statusMap[rawStatus] || rawStatus.toUpperCase();

  // Update calls
  const updateFields: Record<string, unknown> = { status: newStatus };

  if (payload.ended_at) {
    updateFields.ended_at = payload.ended_at;
  } else if (['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED'].includes(newStatus)) {
    updateFields.ended_at = new Date().toISOString();
  }

  const { error: updateError } = await adminClient.from('calls').update(updateFields)
    .eq('id', call.id).eq('company_id', companyId).eq('provider', provider);
  if (updateError) throw new ServerAuthError('Lỗi cập nhật trạng thái cuộc gọi.', 500, 'INTERNAL_ERROR');

  // Nếu cuộc gọi kết thúc → cập nhật attempt result
  const terminalStatuses = ['COMPLETED', 'NO_ANSWER', 'BUSY', 'FAILED'];
  if (terminalStatuses.includes(newStatus)) {
    // Tìm attempt tương ứng
    const { data: attempts } = await adminClient
      .from('call_attempts')
      .select('id, attempt_no, contact_cycle_id, customer_id, company_id, result')
      .eq('call_id', call.id)
      .eq('company_id', call.company_id)
      .eq('result', 'PENDING') // chỉ update nếu vẫn PENDING
      .limit(1);

    if (attempts && attempts.length > 0) {
      const attempt = attempts[0] as {
        id: string;
        attempt_no: number;
        contact_cycle_id: string;
        customer_id: string;
        company_id: string;
        result: string;
      };

      const attemptResult =
        newStatus === 'COMPLETED' ? 'ANSWERED' :
        newStatus === 'NO_ANSWER' ? 'NO_ANSWER' :
        newStatus === 'BUSY' ? 'BUSY' :
        'FAILED';

      await markAttemptResult(attempt.id, call.company_id, attemptResult, call.id);
    }
  }

  if (newStatus === 'COMPLETED') {
    try {
      await processRecordingReady({
        event: 'call.recording_ready',
        provider_call_id: providerCallId,
        recording_id: payload.recording_id || providerCallId,
      }, call.company_id, provider);
    } catch {
      // Status delivery must remain idempotent; the provider may send recording_ready later.
    }
  }

  return { handled: true, message: `call ${call.id} updated to ${newStatus}` };
}

// ---------------------------------------------------------------------------
// Xử lý event: call.inbound
// ---------------------------------------------------------------------------

/**
 * Xử lý cuộc gọi Hotline inbound từ khách.
 *
 * Quy tắc (PROJECT_MASTER §4):
 * - Inbound KHÔNG tạo call_attempts, KHÔNG tính vào quy tắc 3 lần.
 * - Tìm customer theo normalized_phone (qua HMAC lookup trong identities).
 * - Nếu chưa có customer → tạo mới với source='HOTLINE'.
 * - Ghi calls (INBOUND, AI) + interactions (HOTLINE, CALL_EVENT, SYSTEM).
 *
 * SECURITY:
 * - from_number trong payload là raw phone từ tổng đài.
 * - KHÔNG log from_number.
 * - KHÔNG lưu từ payload trực tiếp vào bảng public.
 * - Chỉ dùng để lookup identity trong private schema.
 */
export async function processInboundCall(
  payload: VoiceWebhookPayload,
  companyId: string,
  provider: 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON' = 'STRINGEE'
): Promise<WebhookProcessResult> {
  const adminClient = createAdminClient();

  // Chống ghi trùng: kiểm tra provider_call_id đã tồn tại chưa
  if (payload.provider_call_id) {
    const existing = await findCallByProviderCallId(payload.provider_call_id, companyId, provider);
    if (existing) {
      return { handled: true, message: `inbound call already recorded: ${existing.id}` };
    }
  }

  const normalizedPhone = payload.from_number
    ? normalizeVietnamPhoneToE164(payload.from_number)
    : null;
  const identitySecret = process.env.PHONE_IDENTITY_HMAC_SECRET;
  if (!normalizedPhone || !payload.from_number || !payload.provider_call_id || !identitySecret) {
    return { handled: false, message: 'canonical inbound identity is unavailable' };
  }
  const identityHash = createHmac('sha256', identitySecret)
    .update(`${companyId}:${normalizedPhone}`).digest('hex');
  const { data: customerData, error: customerError } = await adminClient.rpc(
    'resolve_or_create_hotline_customer', {
      p_company_id: companyId,
      p_normalized_phone: normalizedPhone,
      p_raw_phone: payload.from_number,
      p_phone_identity_hash: identityHash,
    }
  );
  if (customerError || !customerData) {
    throw new ServerAuthError('Lỗi định danh khách gọi Hotline.', 500, 'INTERNAL_ERROR');
  }
  const customerId = customerData as string;
  const { error: callError } = await adminClient.rpc('create_inbound_voice_call', {
    p_company_id: companyId,
    p_customer_id: customerId,
    p_provider: provider,
    p_provider_call_id: payload.provider_call_id,
  });
  if (callError) throw new ServerAuthError('Lỗi lưu cuộc gọi Hotline inbound.', 500, 'INTERNAL_ERROR');

  // KHÔNG tạo call_attempts — inbound không thuộc chu kỳ 3 lần
  return {
    handled: true,
    message: 'inbound call recorded',
  };
}

// ---------------------------------------------------------------------------
// Lưu recording_ref sau khi recording đã được download server-side
// ---------------------------------------------------------------------------

/**
 * Cập nhật recording_ref vào call record sau khi ghi âm đã được
 * download từ provider và lưu vào bucket 'call-recordings'.
 *
 * SECURITY: URL gốc từ provider KHÔNG được lưu vào DB.
 * Chỉ internal storage ref mới được lưu.
 */
export async function updateCallRecordingRef(
  callId: string,
  companyId: string,
  internalRecordingRef: string
): Promise<void> {
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('calls')
    .update({ recording_ref: internalRecordingRef })
    .eq('id', callId)
    .eq('company_id', companyId);

  if (error) {
    throw new ServerAuthError('Lỗi lưu tham chiếu ghi âm.', 500, 'INTERNAL_ERROR');
  }
}

// ---------------------------------------------------------------------------
// Cập nhật transcript_status
// ---------------------------------------------------------------------------

export async function updateCallTranscriptStatus(
  callId: string,
  companyId: string,
  transcriptStatus: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
): Promise<void> {
  const adminClient = createAdminClient();

  await adminClient
    .from('calls')
    .update({ transcript_status: transcriptStatus })
    .eq('id', callId)
    .eq('company_id', companyId);
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

/** Store a whitelisted AI intake result and create an unassigned survey request. */
export async function processCallIntake(
  payload: VoiceWebhookPayload,
  companyId: string,
  provider: 'STRINGEE' | 'VIETTEL' | 'TWILIO' | 'VINFON' = 'STRINGEE'
): Promise<WebhookProcessResult> {
  const providerCallId = payload.provider_call_id || payload.call_id;
  if (!providerCallId || !payload.intake) return { handled: false, message: 'intake data missing' };
  const call = await findCallByProviderCallId(providerCallId, companyId, provider);
  if (!call) return { handled: false, message: 'call not found' };

  const intake = payload.intake;
  const safeInteger = (value: unknown) => Number.isInteger(value) ? value as number : null;
  const surveyRequested = intake.survey_requested === true;
  const preferredAt = intake.preferred_survey_at && !Number.isNaN(Date.parse(intake.preferred_survey_at))
    ? new Date(intake.preferred_survey_at).toISOString()
    : null;
  const row = {
    company_id: companyId,
    call_id: call.id,
    customer_id: call.customer_id,
    customer_name: cleanText(intake.customer_name, 160),
    door_type: cleanText(intake.door_type, 120),
    width_mm: safeInteger(intake.width_mm),
    height_mm: safeInteger(intake.height_mm),
    flood_depth_mm: safeInteger(intake.flood_depth_mm),
    opening_count: safeInteger(intake.opening_count),
    survey_address: cleanText(intake.survey_address, 500),
    survey_requested: surveyRequested,
    preferred_survey_at: preferredAt,
    notes: cleanText(intake.notes, 2000),
    status: surveyRequested ? 'SURVEY_REQUESTED' : 'INTAKE_COMPLETED',
  };

  const adminClient = createAdminClient();
  const { error } = await adminClient.from('voice_call_intakes').upsert(row, {
    onConflict: 'company_id,call_id',
  });
  if (error) throw new ServerAuthError('Lỗi lưu thông tin cuộc gọi.', 500, 'INTERNAL_ERROR');

  if (row.customer_name) {
    await adminClient.from('customers').update({ name: row.customer_name })
      .eq('id', call.customer_id).eq('company_id', companyId).eq('name', 'Khách gọi Hotline');
  }
  return { handled: true, message: surveyRequested ? 'survey request recorded' : 'call intake recorded' };
}
