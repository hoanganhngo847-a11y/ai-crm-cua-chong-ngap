import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import { authorizeSurveyAppointment } from './access.service';
import type { SurveyPhotoItem, SurveyPhotoSlot } from '../types/survey';

const SURVEY_PHOTOS_BUCKET = 'survey-photos';
const PHOTO_TTL = 3600;
export const VALID_PHOTO_SLOTS: readonly SurveyPhotoSlot[] = [
  'OVERVIEW', 'BOTTOM_LEFT', 'BOTTOM_RIGHT', 'OBSTACLE', 'SLOPE_DETAIL', 'ADDITIONAL',
];
const MANDATORY = ['OVERVIEW', 'BOTTOM_LEFT', 'BOTTOM_RIGHT'] as const;

export function sanitizePhotoSlot(slot: string): SurveyPhotoSlot {
  if (!VALID_PHOTO_SLOTS.includes(slot as SurveyPhotoSlot)) throw new Error('Vị trí ảnh không hợp lệ.');
  return slot as SurveyPhotoSlot;
}

interface StorageContext { companyId: string; customerId: string; appointmentId: string }
function folderFor(context: StorageContext) {
  return `${context.companyId}/${context.customerId}/${context.appointmentId}`;
}
function contextFor(a: { company_id: string; customer_id: string; id: string }): StorageContext {
  return { companyId: a.company_id, customerId: a.customer_id, appointmentId: a.id };
}

export const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export interface ImageSignatureResult {
  isValid: boolean;
  mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
  error?: string;
}

/**
 * Validates binary signature (Magic Bytes) of an uploaded image file:
 * - Rejects 0-byte empty files
 * - JPEG: [0xFF, 0xD8, 0xFF]
 * - PNG: [0x89, 0x50, 0x4E, 0x47]
 * - WEBP: bytes 0-3 'RIFF' ([0x52, 0x49, 0x46, 0x46]) and bytes 8-11 'WEBP' ([0x57, 0x45, 0x42, 0x50])
 */
export function validateImageFileSignature(
  buffer: Buffer | ArrayBuffer | Uint8Array
): ImageSignatureResult {
  let bytes: Uint8Array;
  if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer);
  } else if (buffer instanceof Uint8Array) {
    bytes = buffer;
  } else {
    return {
      isValid: false,
      error: 'Dữ liệu tệp không hợp lệ.',
    };
  }

  // 1. Chặn file rỗng
  if (bytes.length === 0) {
    return {
      isValid: false,
      error: 'Tệp tải lên rỗng (0 bytes).',
    };
  }

  // 2. JPEG Magic Bytes: [0xFF, 0xD8, 0xFF]
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return {
      isValid: true,
      mimeType: 'image/jpeg',
    };
  }

  // 3. PNG Magic Bytes: [0x89, 0x50, 0x4E, 0x47]
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      isValid: true,
      mimeType: 'image/png',
    };
  }

  // 4. WEBP Magic Bytes:
  // Bytes 0-3: 'RIFF' (0x52, 0x49, 0x46, 0x46)
  // Bytes 8-11: 'WEBP' (0x57, 0x45, 0x42, 0x50)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return {
      isValid: true,
      mimeType: 'image/webp',
    };
  }

  return {
    isValid: false,
    error: 'Định dạng tệp không hợp lệ. Chỉ chấp nhận ảnh JPG, PNG, WEBP thực tế.',
  };
}



// A durable operation guard serializes uploads/deletes with completion and reassignment.
// A crashed worker leaves a guard for explicit reconciliation; it never expires into unsafe access.
async function withPhotoMutation<T>(appointmentId: string, work: (
  client: ReturnType<typeof createAdminClient>, context: StorageContext
) => Promise<T>): Promise<T> {
  const { actor, appointment, adminClient } = await authorizeSurveyAppointment(appointmentId, true);
  const { data: token, error } = await adminClient.rpc('begin_survey_photo_operation', {
    p_appointment_id: appointment.id, p_actor_id: actor.userId,
  });
  if (error || typeof token !== 'string') throw new Error('Không thể khóa ảnh khảo sát. Vui lòng thử lại.');
  try {
    return await work(adminClient, contextFor(appointment));
  } finally {
    const { error: releaseError } = await adminClient.rpc('end_survey_photo_operation', {
      p_appointment_id: appointment.id, p_token: token,
    });
    if (releaseError) throw new Error('Không thể xác nhận thao tác ảnh. Cần kiểm tra lại lịch khảo sát.');
  }
}

export async function uploadSurveyPhotoToStorage(params: {
  appointmentId: string; photoSlot: string; fileBuffer: ArrayBuffer | Buffer | Uint8Array;
}): Promise<{ signedUrl: string }> {
  const slot = sanitizePhotoSlot(params.photoSlot);
  if (params.fileBuffer.byteLength > MAX_PHOTO_SIZE_BYTES) throw new Error('Dung lượng ảnh không được vượt quá 10MB.');
  const signature = validateImageFileSignature(params.fileBuffer);
  if (!signature.isValid) throw new Error(signature.error);
  return withPhotoMutation(params.appointmentId, async (client, context) => {
    // One deterministic active object per slot. Failed replacement preserves the previous object.
    const path = `${folderFor(context)}/${slot}.jpg`;
    const { error } = await client.storage.from(SURVEY_PHOTOS_BUCKET).upload(path, params.fileBuffer, {
      contentType: signature.mimeType, upsert: true,
    });
    if (error) throw new Error('Không thể tải ảnh lên kho lưu trữ.');
    const { data, error: signError } = await client.storage.from(SURVEY_PHOTOS_BUCKET).createSignedUrl(path, PHOTO_TTL);
    if (signError || !data?.signedUrl) throw new Error('Không thể tạo đường dẫn xem trước.');
    return { signedUrl: data.signedUrl };
  });
}

export async function deleteSurveyPhotosForSlot(appointmentId: string, photoSlot: string): Promise<void> {
  const slot = sanitizePhotoSlot(photoSlot);
  await withPhotoMutation(appointmentId, async (client, context) => {
    const path = `${folderFor(context)}/${slot}.jpg`;
    const { error } = await client.storage.from(SURVEY_PHOTOS_BUCKET).remove([path]);
    if (error) throw new Error('Không thể xóa ảnh khỏi kho lưu trữ.');
  });
}

export async function getSurveyPhotoSignedUrl(appointmentId: string, photoSlot: string): Promise<string | null> {
  const slot = sanitizePhotoSlot(photoSlot);
  const { appointment, adminClient } = await authorizeSurveyAppointment(appointmentId);
  const folder = folderFor(contextFor(appointment));
  const { data: files, error: listError } = await adminClient.storage.from(SURVEY_PHOTOS_BUCKET)
    .list(folder, { search: `${slot}.jpg`, limit: 100 });
  if (listError || !files?.some(f => f.name === `${slot}.jpg` && f.id)) return null;
  const { data, error } = await adminClient.storage.from(SURVEY_PHOTOS_BUCKET)
    .createSignedUrl(`${folder}/${slot}.jpg`, PHOTO_TTL);
  return error ? null : data?.signedUrl || null;
}

/** Internal completion evidence resolver. Context must come from an authorized appointment. */
export async function verifyMandatoryPhotosInStorage(context: StorageContext,
  client: ReturnType<typeof createAdminClient> = createAdminClient()
): Promise<{ isValid: boolean; missingSlots: string[]; photos: SurveyPhotoItem[] }> {
  const folder = folderFor(context);
  const photos: SurveyPhotoItem[] = [];
  // Exact names only: never select an arbitrary newest legacy file or reuse OBSTACLE as BOTTOM_RIGHT.
  for (const slot of VALID_PHOTO_SLOTS) {
    const { data, error } = await client.storage.from(SURVEY_PHOTOS_BUCKET)
      .list(folder, { search: `${slot}.jpg`, limit: 100 });
    if (error) return { isValid: false, missingSlots: [...MANDATORY], photos: [] };
    const file = data?.find(f => f.name === `${slot}.jpg` && f.id);
    if (file) photos.push({ slot, objectPath: `${folder}/${slot}.jpg`, uploadedAt: file.created_at || file.updated_at || '',
      slotLabel: slot, isMandatory: (MANDATORY as readonly string[]).includes(slot) });
  }
  const missingSlots = MANDATORY.filter(slot => !photos.some(p => p.slot === slot));
  return { isValid: missingSlots.length === 0, missingSlots, photos };
}
