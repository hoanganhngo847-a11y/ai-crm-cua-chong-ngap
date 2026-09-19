'use server';

import { revalidatePath } from 'next/cache';
import { getActorContext } from '../../../lib/auth/context';
import { createAdminClient } from '../../../lib/supabase/admin';
import {
  uploadSurveyPhotoToStorage,
  deleteSurveyPhotoFromStorage,
  getSurveyPhotoSignedUrl,
} from '../../../features/survey/services/storage-upload.service';

export interface ActionResponse {
  success: boolean;
  message?: string;
  redirectUrl?: string;
}

export interface UploadPhotoActionResponse {
  success: boolean;
  objectPath?: string;
  signedUrl?: string;
  message?: string;
}

/**
 * Validates technician / actor permissions on target appointment.
 */
async function verifyAppointmentPermission(appointmentId: string) {
  const actor = await getActorContext();
  if (!actor || actor.profileStatus !== 'ACTIVE' || !actor.companyId) {
    throw new Error('Bạn chưa đăng nhập hoặc tài khoản không hoạt động.');
  }

  const adminClient = createAdminClient();
  const { data: appointment, error } = await adminClient
    .from('appointments')
    .select('id, company_id, customer_id, assignee_id, status, type')
    .eq('id', appointmentId)
    .maybeSingle();

  if (error || !appointment) {
    throw new Error('Không tìm thấy lịch hẹn khảo sát.');
  }

  if (appointment.company_id !== actor.companyId) {
    throw new Error('Lịch hẹn không thuộc doanh nghiệp của bạn.');
  }

  // Technicians can only operate on their own assigned appointments
  if (actor.role === 'TECHNICIAN' && appointment.assignee_id !== actor.userId) {
    throw new Error('Bạn không có quyền thao tác trên lịch hẹn của kỹ thuật viên khác.');
  }

  return { actor, appointment, adminClient };
}

/**
 * Action: Kỹ thuật viên nhận lịch hẹn (ASSIGNED -> ACCEPTED)
 */
export async function acceptSurveyAppointmentAction(
  appointmentId: string
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(appointmentId);

    if (appointment.status !== 'ASSIGNED') {
      return {
        success: false,
        message: 'Lịch hẹn không ở trạng thái chờ nhận việc (ASSIGNED).',
      };
    }

    const { error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'ACCEPTED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId);

    if (updateError) {
      return {
        success: false,
        message: `Lỗi cập nhật trạng thái: ${updateError.message}`,
      };
    }

    revalidatePath('/surveys');
    return { success: true, message: 'Đã nhận lịch khảo sát thành công.' };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Lỗi hệ thống khi nhận lịch.',
    };
  }
}

/**
 * Action: Kỹ thuật viên bắt đầu đến đo (ACCEPTED/ASSIGNED -> IN_PROGRESS)
 * Chuyển hướng tới form nhập số đo tại /surveys/[appointmentId]
 */
export async function startSurveyAppointmentAction(
  appointmentId: string
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(appointmentId);

    if (appointment.status !== 'ACCEPTED' && appointment.status !== 'ASSIGNED') {
      if (appointment.status === 'IN_PROGRESS') {
        // Already in progress, just navigate
        return {
          success: true,
          redirectUrl: `/surveys/${appointmentId}`,
        };
      }
      return {
        success: false,
        message: 'Lịch hẹn không ở trạng thái có thể bắt đầu đo.',
      };
    }

    const { error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'IN_PROGRESS',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId);

    if (updateError) {
      return {
        success: false,
        message: `Lỗi cập nhật trạng thái: ${updateError.message}`,
      };
    }

    revalidatePath('/surveys');
    return {
      success: true,
      redirectUrl: `/surveys/${appointmentId}`,
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Lỗi hệ thống khi bắt đầu đo.',
    };
  }
}

/**
 * Action: Hủy lịch khảo sát (-> CANCELLED)
 */
export async function cancelSurveyAppointmentAction(
  appointmentId: string
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(appointmentId);

    if (appointment.status === 'COMPLETED') {
      return {
        success: false,
        message: 'Không thể hủy lịch hẹn đã hoàn thành khảo sát.',
      };
    }

    const { error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'CANCELLED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId);

    if (updateError) {
      return {
        success: false,
        message: `Lỗi hủy lịch: ${updateError.message}`,
      };
    }

    revalidatePath('/surveys');
    return { success: true, message: 'Đã hủy lịch hẹn khảo sát.' };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Lỗi hệ thống khi hủy lịch.',
    };
  }
}

/**
 * Action: Tải ảnh khảo sát lên bucket 'survey-photos'
 * Cấu trúc đường dẫn: `${company_id}/${customer_id}/${appointment_id}/${photo_slot}_${timestamp}.jpg`
 */
export async function uploadSurveyPhotoAction(
  formData: FormData
): Promise<UploadPhotoActionResponse> {
  try {
    const appointmentId = formData.get('appointmentId') as string;
    const photoSlot = formData.get('photoSlot') as string;
    const file = formData.get('file') as File;

    if (!appointmentId || !photoSlot || !file) {
      return { success: false, message: 'Thiếu thông tin ảnh hoặc mã lịch hẹn.' };
    }

    const { appointment } = await verifyAppointmentPermission(appointmentId);

    const arrayBuffer = await file.arrayBuffer();
    const result = await uploadSurveyPhotoToStorage({
      fileBuffer: Buffer.from(arrayBuffer),
      companyId: appointment.company_id,
      customerId: appointment.customer_id,
      appointmentId: appointment.id,
      photoSlot,
      contentType: file.type || 'image/jpeg',
    });

    return {
      success: true,
      objectPath: result.objectPath,
      signedUrl: result.signedUrl,
      message: 'Tải ảnh thành công.',
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Lỗi hệ thống khi tải ảnh.',
    };
  }
}

/**
 * Action: Xóa ảnh khảo sát khỏi bucket 'survey-photos'
 */
export async function deleteSurveyPhotoAction(
  appointmentId: string,
  objectPath: string
): Promise<ActionResponse> {
  try {
    await verifyAppointmentPermission(appointmentId);
    await deleteSurveyPhotoFromStorage(objectPath);
    return { success: true, message: 'Đã xóa ảnh.' };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Lỗi hệ thống khi xóa ảnh.',
    };
  }
}

/**
 * Action: Làm mới signed URL cho ảnh khảo sát (hết hạn sau 3600s)
 */
export async function refreshPhotoSignedUrlAction(
  appointmentId: string,
  objectPath: string
): Promise<{ success: boolean; signedUrl?: string }> {
  try {
    await verifyAppointmentPermission(appointmentId);
    const signedUrl = await getSurveyPhotoSignedUrl(objectPath, 3600);
    return { success: !!signedUrl, signedUrl: signedUrl || undefined };
  } catch {
    return { success: false };
  }
}

export interface CompleteSurveyActionResponse {
  success: boolean;
  message?: string;
  surveyId?: string;
  missingFields?: string[];
  errors?: Record<string, string>;
  redirectUrl?: string;
}

/**
 * Action: Kỹ thuật viên chốt hoàn tất khảo sát & đồng bộ dữ liệu kỹ thuật cho TV7
 */
export async function completeSurveyAction(
  input: import('../../../features/survey/types/survey').CompleteSurveyInput
): Promise<CompleteSurveyActionResponse> {
  try {
    const { actor } = await verifyAppointmentPermission(input.appointmentId);

    const { completeSurvey } = await import('../../../features/survey/services/survey.service');
    const result = await completeSurvey(input, actor.userId, actor.companyId!);

    if (!result.success) {
      return {
        success: false,
        message: result.message,
        missingFields: result.missingFields,
        errors: result.errors,
      };
    }

    revalidatePath('/surveys');
    revalidatePath(`/surveys/${input.appointmentId}`);

    return {
      success: true,
      message: 'Khảo sát đã hoàn tất. Dữ liệu đã sẵn sàng cho bộ phận tính giá.',
      surveyId: result.surveyId,
      redirectUrl: '/surveys',
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : 'Lỗi hệ thống khi hoàn tất khảo sát.',
    };
  }
}

