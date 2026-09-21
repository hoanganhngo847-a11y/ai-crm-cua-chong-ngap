import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';
import type { SurveyPhotoItem, SurveyPhotoSlot } from '../types/survey';

export const SURVEY_PHOTOS_BUCKET = 'survey-photos';

export const VALID_PHOTO_SLOTS: readonly SurveyPhotoSlot[] = [
  'OVERVIEW',
  'BOTTOM_LEFT',
  'BOTTOM_RIGHT',
  'OBSTACLE',
  'SLOPE_DETAIL',
  'ADDITIONAL',
] as const;

/**
 * Validates and sanitizes a photoSlot string to prevent directory traversal or arbitrary naming.
 */
export function sanitizePhotoSlot(slot: string): SurveyPhotoSlot {
  if (!slot || typeof slot !== 'string') {
    throw new Error('Thiếu hoặc sai định dạng vị trí ảnh (photoSlot).');
  }
  const sanitized = slot.trim().toUpperCase() as SurveyPhotoSlot;
  if (!VALID_PHOTO_SLOTS.includes(sanitized)) {
    throw new Error(`Vị trí ảnh không hợp lệ: "${slot}".`);
  }
  return sanitized;
}

export interface GeneratePhotoPathParams {
  companyId: string;
  customerId: string;
  appointmentId: string;
  photoSlot: string;
  timestamp?: number;
}

export interface UploadSurveyPhotoParams {
  fileBuffer: ArrayBuffer | Buffer | Uint8Array;
  companyId: string;
  customerId: string;
  appointmentId: string;
  photoSlot: string;
  contentType?: string;
  client?: import('@supabase/supabase-js').SupabaseClient;
}

export interface SlotStorageParams {
  companyId: string;
  customerId: string;
  appointmentId: string;
  photoSlot: string;
}

export interface UploadPhotoResult {
  objectPath: string;
  signedUrl: string;
}

/**
 * Generates the canonical storage object path:
 * Format: `${company_id}/${customer_id}/${appointment_id}/${photo_slot}_${timestamp}.jpg`
 */
export function generateSurveyPhotoPath({
  companyId,
  customerId,
  appointmentId,
  photoSlot,
  timestamp = Date.now(),
}: GeneratePhotoPathParams): string {
  const sanitizedSlot = sanitizePhotoSlot(photoSlot);
  return `${companyId}/${customerId}/${appointmentId}/${sanitizedSlot}_${timestamp}.jpg`;
}

/**
 * Searches and derives the actual storage path of a photo associated with an appointment slot.
 */
export async function findSurveyPhotoPathForSlot({
  companyId,
  customerId,
  appointmentId,
  photoSlot,
}: SlotStorageParams): Promise<string | null> {
  const sanitizedSlot = sanitizePhotoSlot(photoSlot);
  const folder = `${companyId}/${customerId}/${appointmentId}`;
  const adminClient = createAdminClient();

  const { data: files, error } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .list(folder, { search: sanitizedSlot });

  if (error || !files || files.length === 0) {
    return null;
  }

  const matching = files.filter(
    (f) => f.name === `${sanitizedSlot}.jpg` || f.name.startsWith(`${sanitizedSlot}_`)
  );

  if (matching.length === 0) {
    return null;
  }

  // Sort descending by created_at or filename so the newest upload is picked
  matching.sort((a, b) => {
    const timeA = a.created_at || a.name;
    const timeB = b.created_at || b.name;
    return timeB.localeCompare(timeA);
  });

  return `${folder}/${matching[0].name}`;
}

/**
 * Deletes any existing storage photos belonging to a specific appointment slot.
 * Ensures no orphan or duplicate files remain.
 */
export async function deleteSurveyPhotosForSlot({
  companyId,
  customerId,
  appointmentId,
  photoSlot,
}: SlotStorageParams): Promise<boolean> {
  const sanitizedSlot = sanitizePhotoSlot(photoSlot);
  const folder = `${companyId}/${customerId}/${appointmentId}`;
  const adminClient = createAdminClient();

  const { data: files } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .list(folder, { search: sanitizedSlot });

  const filesToDelete: string[] = [];

  if (files && files.length > 0) {
    for (const f of files) {
      if (f.name === `${sanitizedSlot}.jpg` || f.name.startsWith(`${sanitizedSlot}_`)) {
        filesToDelete.push(`${folder}/${f.name}`);
      }
    }
  }

  // Also include the canonical deterministic path if not already in list
  const canonicalPath = `${folder}/${sanitizedSlot}.jpg`;
  if (!filesToDelete.includes(canonicalPath)) {
    filesToDelete.push(canonicalPath);
  }

  const { error } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .remove(filesToDelete);

  return !error;
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


/**
 * Uploads a survey photo to the private 'survey-photos' Supabase Storage bucket.
 * Generates a signed URL valid for 3600 seconds (1 hour) for immediate thumbnail preview.
 */
export async function uploadSurveyPhotoToStorage({
  fileBuffer,
  companyId,
  customerId,
  appointmentId,
  photoSlot,
  client,
}: UploadSurveyPhotoParams): Promise<UploadPhotoResult> {
  if (!companyId || !customerId || !appointmentId || !photoSlot) {
    throw new Error('Thiếu tham số định danh bắt buộc để lưu ảnh khảo sát.');
  }

  // Khống chế dung lượng file tối đa: 10MB
  const byteLength =
    fileBuffer instanceof ArrayBuffer
      ? fileBuffer.byteLength
      : (fileBuffer as Buffer).length ?? (fileBuffer as Uint8Array).byteLength;

  if (byteLength > MAX_PHOTO_SIZE_BYTES) {
    throw new Error('Dung lượng ảnh không được vượt quá 10MB.');
  }

  // Kiểm tra qua validateImageFileSignature
  const sigResult = validateImageFileSignature(fileBuffer);
  if (!sigResult.isValid || !sigResult.mimeType) {
    throw new Error(
      sigResult.error || 'Định dạng tệp không hợp lệ. Chỉ chấp nhận ảnh JPG, PNG, WEBP thực tế.'
    );
  }

  // Sử dụng MIME type đã được xác thực qua magic bytes thay vì tin cậy browser
  const verifiedMimeType = sigResult.mimeType;

  const sanitizedSlot = sanitizePhotoSlot(photoSlot);
  const adminClient = client || createAdminClient();
  const objectPath = generateSurveyPhotoPath({
    companyId,
    customerId,
    appointmentId,
    photoSlot: sanitizedSlot,
  });

  // 1. Upload to Supabase Storage with verified MIME type
  const { error: uploadError } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .upload(objectPath, fileBuffer, {
      contentType: verifiedMimeType,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Lỗi tải ảnh lên lưu trữ: ${uploadError.message}`);
  }

  // 2. Generate signed URL for thumbnail preview (TTL: 3600s / 1 hour)
  const { data: signedData, error: signedError } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .createSignedUrl(objectPath, 3600);

  if (signedError || !signedData?.signedUrl) {
    throw new Error(
      `Tải ảnh thành công nhưng không thể tạo đường dẫn xem trước: ${signedError?.message || 'Lỗi không xác định'}`
    );
  }

  return {
    objectPath,
    signedUrl: signedData.signedUrl,
  };
}

/**
 * Deletes a survey photo from 'survey-photos' bucket if retaken or removed by user.
 */
export async function deleteSurveyPhotoFromStorage(objectPath: string): Promise<boolean> {
  if (!objectPath) return false;

  const adminClient = createAdminClient();
  const { error } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .remove([objectPath]);

  return !error;
}

/**
 * Generates a short-lived signed URL for an existing survey photo object path.
 */
export async function getSurveyPhotoSignedUrl(
  objectPath: string,
  expiresIn = 3600
): Promise<string | null> {
  if (!objectPath) return null;

  const adminClient = createAdminClient();
  const { data, error } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .createSignedUrl(objectPath, expiresIn);

  if (error || !data?.signedUrl) {
    return null;
  }

  return data.signedUrl;
}

export interface VerifyPhotosInStorageContext {
  companyId: string;
  customerId: string;
  appointmentId: string;
}

export interface VerifyPhotosInStorageResult {
  isValid: boolean;
  missingSlots: string[];
  photos: SurveyPhotoItem[];
  error?: string;
}

/**
 * Verifies that all mandatory survey photos physically exist in Supabase Storage.
 * Prevents clients from spoofing the photo array during survey completion.
 * Lists files under `${companyId}/${customerId}/${appointmentId}/` in bucket 'survey-photos'.
 * Validates presence of:
 * 1. FRONTAGE / OVERVIEW
 * 2. FLOOR_JUNCTION / BOTTOM_LEFT
 * 3. OBSTACLES / BOTTOM_RIGHT / OBSTACLE
 * Returns canonical SurveyPhotoItem records derived directly from storage.
 */
export async function verifyMandatoryPhotosInStorage(
  context: VerifyPhotosInStorageContext,
  client?: import('@supabase/supabase-js').SupabaseClient
): Promise<VerifyPhotosInStorageResult> {
  const { companyId, customerId, appointmentId } = context;
  if (!companyId || !customerId || !appointmentId) {
    return {
      isValid: false,
      missingSlots: ['FRONTAGE', 'FLOOR_JUNCTION', 'OBSTACLES'],
      photos: [],
      error: 'Thiếu thông tin định danh lịch hẹn để kiểm tra kho lưu trữ.',
    };
  }

  const folder = `${companyId}/${customerId}/${appointmentId}`;
  const adminClient = client || createAdminClient();

  const { data: files, error } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .list(folder);

  if (error || !files || files.length === 0) {
    return {
      isValid: false,
      missingSlots: ['FRONTAGE', 'FLOOR_JUNCTION', 'OBSTACLES'],
      photos: [],
      error: error ? `Lỗi truy vấn storage: ${error.message}` : 'Thư mục ảnh trống trên hệ thống lưu trữ.',
    };
  }

  // Canonical slot definitions and recognition aliases
  const SLOT_CONFIGS: Array<{
    canonicalSlot: SurveyPhotoSlot;
    aliases: string[];
    label: string;
    isMandatory: boolean;
  }> = [
    {
      canonicalSlot: 'OVERVIEW',
      aliases: ['OVERVIEW', 'FRONTAGE'],
      label: 'Ảnh toàn cảnh mặt tiền',
      isMandatory: true,
    },
    {
      canonicalSlot: 'BOTTOM_LEFT',
      aliases: ['BOTTOM_LEFT', 'FLOOR_JUNCTION'],
      label: 'Chân tường & sàn bên trái / Tiếp giáp sàn',
      isMandatory: true,
    },
    {
      canonicalSlot: 'BOTTOM_RIGHT',
      aliases: ['BOTTOM_RIGHT', 'OBSTACLES', 'OBSTACLE'],
      label: 'Chân tường & sàn bên phải / Chướng ngại vật',
      isMandatory: true,
    },
    {
      canonicalSlot: 'OBSTACLE',
      aliases: ['OBSTACLE', 'OBSTACLES'],
      label: 'Chướng ngại vật / Gờ chỉ',
      isMandatory: false,
    },
    {
      canonicalSlot: 'SLOPE_DETAIL',
      aliases: ['SLOPE_DETAIL'],
      label: 'Chi tiết dốc / Cốt nền',
      isMandatory: false,
    },
    {
      canonicalSlot: 'ADDITIONAL',
      aliases: ['ADDITIONAL'],
      label: 'Ảnh bổ sung hiện trường',
      isMandatory: false,
    },
  ];

  const foundSlots = new Set<string>();
  const detectedPhotos: SurveyPhotoItem[] = [];

  for (const f of files) {
    if (!f.name || f.name.startsWith('.')) continue;

    const baseName = f.name.replace(/\.[^/.]+$/, '');
    const slotFromFilename = baseName.replace(/_\d+$/, '').toUpperCase();

    const matchedConfig = SLOT_CONFIGS.find((cfg) =>
      cfg.aliases.includes(slotFromFilename)
    );

    if (matchedConfig) {
      const canonicalSlot = matchedConfig.canonicalSlot;
      matchedConfig.aliases.forEach((alias) => foundSlots.add(alias));
      foundSlots.add(canonicalSlot);

      detectedPhotos.push({
        slot: canonicalSlot,
        objectPath: `${folder}/${f.name}`,
        uploadedAt: f.created_at || f.updated_at || new Date().toISOString(),
        slotLabel: matchedConfig.label,
        isMandatory: matchedConfig.isMandatory,
      });
    }
  }

  // Deduplicate by slot taking the newest by file name / timestamp
  const uniquePhotosMap = new Map<string, SurveyPhotoItem>();
  for (const item of detectedPhotos) {
    const existing = uniquePhotosMap.get(item.slot);
    if (!existing || item.objectPath.localeCompare(existing.objectPath) > 0) {
      uniquePhotosMap.set(item.slot, item);
    }
  }
  const canonicalPhotos = Array.from(uniquePhotosMap.values());

  const hasFrontage = foundSlots.has('OVERVIEW') || foundSlots.has('FRONTAGE');
  const hasFloorJunction = foundSlots.has('BOTTOM_LEFT') || foundSlots.has('FLOOR_JUNCTION');
  const hasObstacles =
    foundSlots.has('BOTTOM_RIGHT') || foundSlots.has('OBSTACLES') || foundSlots.has('OBSTACLE');

  const missingSlots: string[] = [];
  if (!hasFrontage) missingSlots.push('FRONTAGE');
  if (!hasFloorJunction) missingSlots.push('FLOOR_JUNCTION');
  if (!hasObstacles) missingSlots.push('OBSTACLES');

  return {
    isValid: missingSlots.length === 0,
    missingSlots,
    photos: canonicalPhotos,
  };
}
