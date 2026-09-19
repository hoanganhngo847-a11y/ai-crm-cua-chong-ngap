import 'server-only';
import { createAdminClient } from '../../../lib/supabase/admin';

export const SURVEY_PHOTOS_BUCKET = 'survey-photos';

export interface GeneratePhotoPathParams {
  companyId: string;
  customerId: string;
  appointmentId: string;
  photoSlot: string;
  timestamp?: number;
}

export interface UploadSurveyPhotoParams {
  fileBuffer: ArrayBuffer | Buffer;
  companyId: string;
  customerId: string;
  appointmentId: string;
  photoSlot: string;
  contentType?: string;
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
  const sanitizedSlot = photoSlot.trim().toUpperCase();
  return `${companyId}/${customerId}/${appointmentId}/${sanitizedSlot}_${timestamp}.jpg`;
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
  contentType = 'image/jpeg',
}: UploadSurveyPhotoParams): Promise<UploadPhotoResult> {
  if (!companyId || !customerId || !appointmentId || !photoSlot) {
    throw new Error('Thiếu tham số định danh bắt buộc để lưu ảnh khảo sát.');
  }

  const adminClient = createAdminClient();
  const objectPath = generateSurveyPhotoPath({
    companyId,
    customerId,
    appointmentId,
    photoSlot,
  });

  // 1. Upload to Supabase Storage
  const { error: uploadError } = await adminClient.storage
    .from(SURVEY_PHOTOS_BUCKET)
    .upload(objectPath, fileBuffer, {
      contentType,
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
