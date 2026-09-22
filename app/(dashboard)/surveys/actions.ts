'use server';

import { revalidatePath } from 'next/cache';
import { getActorContext } from '../../../lib/auth/context';
import { createAdminClient } from '../../../lib/supabase/admin';
import {
  uploadSurveyPhotoToStorage,
  deleteSurveyPhotosForSlot,
  findSurveyPhotoPathForSlot,
  getSurveyPhotoSignedUrl,
  sanitizePhotoSlot,
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

export interface VerifyAppointmentPermissionOptions {
  isMutation?: boolean;
}

/**
 * Validates technician / actor permissions on target appointment with a fail-closed strategy.
 * When isMutation === true, blocks any mutation on terminal statuses (COMPLETED, CANCELLED) for all roles.
 * When isMutation === false, allows read access for assigned technician and BOSS_ADMIN.
 */
async function verifyAppointmentPermission(
  appointmentId: string,
  allowedRoles: string[] = ['BOSS_ADMIN', 'TECHNICIAN'],
  options: VerifyAppointmentPermissionOptions = {}
) {
  const { isMutation = false } = options;

  const actor = await getActorContext();
  if (
    !actor ||
    !actor.userId ||
    !actor.companyId ||
    actor.profileStatus !== 'ACTIVE' ||
    actor.membershipStatus !== 'ACTIVE'
  ) {
    throw new Error('Bạn chưa đăng nhập hoặc tài khoản/thành viên không hoạt động.');
  }

  if (!actor.role || !allowedRoles.includes(actor.role)) {
    throw new Error('Bạn không có quyền thực hiện thao tác này.');
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

  if (appointment.type !== 'SURVEY') {
    throw new Error('Lịch hẹn không phải là lịch khảo sát hợp lệ.');
  }

  // Khóa mutation đối với trạng thái terminal (COMPLETED, CANCELLED)
  // Áp dụng fail-closed cho TẤT CẢ các vai trò (kể cả BOSS_ADMIN và TECHNICIAN)
  if (isMutation) {
    if (appointment.status === 'COMPLETED' || appointment.status === 'CANCELLED') {
      throw new Error('Không thể chỉnh sửa dữ liệu hoặc hình ảnh của lịch hẹn đã hoàn tất/đã hủy.');
    }
  }

  // Technicians can only operate on their own appointments
  if (actor.role === 'TECHNICIAN') {
    if (appointment.assignee_id !== actor.userId) {
      throw new Error('Bạn không có quyền thao tác trên lịch hẹn của kỹ thuật viên khác.');
    }

    if (isMutation) {
      const validStatuses = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS'];
      if (!validStatuses.includes(appointment.status)) {
        throw new Error('Lịch hẹn đã kết thúc hoặc bị hủy, không thể thao tác.');
      }
    }
  }

  return { actor, appointment, adminClient };
}

/**
 * Normalizes error messages returned to the client UI.
 * - Preserves explicit business, validation, and permission messages.
 * - Logs technical/DB/network/storage details to server console and replaces with safe user-friendly messages.
 */
function normalizeSafeActionError(
  err: unknown,
  fallbackMessage: string = 'Đã xảy ra lỗi hệ thống khi xử lý yêu cầu. Vui lòng thử lại sau.'
): string {
  if (!(err instanceof Error)) {
    return fallbackMessage;
  }

  const msg = err.message || '';

  // Nhận diện lỗi kỹ thuật hạ tầng, database, SQL, storage, network
  const isTechnicalOrDbError =
    /PostgresError|duplicate key|violates unique|violates foreign key|violates not-null|syntax error|relation .* does not exist|ECONNREFUSED|ENOTFOUND|fetch failed|socket hang up|database lock|timeout|JWT|bucket not found|S3|StorageError|code:\s*['"]?[0-9A-Z]{4,5}/i.test(
      msg
    );

  if (isTechnicalOrDbError) {
    return fallbackMessage;
  }

  // Danh sách các thông điệp nghiệp vụ và phân quyền rõ ràng được phép hiển thị ra UI
  if (
    msg.includes('Bạn chưa đăng nhập') ||
    msg.includes('Bạn không có quyền') ||
    msg.includes('Không tìm thấy lịch hẹn') ||
    msg.includes('Lịch hẹn không thuộc doanh nghiệp') ||
    msg.includes('Lịch hẹn không phải là lịch khảo sát') ||
    msg.includes('Lịch hẹn không phải loại SURVEY') ||
    msg.includes('Không thể chỉnh sửa dữ liệu hoặc hình ảnh') ||
    msg.includes('Lịch hẹn đã kết thúc hoặc bị hủy') ||
    msg.includes('Chỉ hỗ trợ tạo lịch hẹn loại SURVEY') ||
    msg.includes('Dung lượng ảnh') ||
    msg.includes('Tệp tải lên rỗng') ||
    msg.includes('Định dạng tệp không hợp lệ') ||
    msg.includes('Thiếu thông tin') ||
    msg.includes('Dữ liệu khảo sát chưa đạt') ||
    msg.includes('Không thể hủy lịch hẹn đã hoàn thành') ||
    msg.includes('Lịch hẹn không ở trạng thái') ||
    msg.includes('SURVEY_ALREADY_EXISTS') ||
    msg.includes('APPOINTMENT_ALREADY_TERMINAL') ||
    msg.includes('APPOINTMENT_NOT_FOUND') ||
    msg.includes('APPOINTMENT_TYPE_NOT_SURVEY')
  ) {
    if (msg.includes('SURVEY_ALREADY_EXISTS:')) {
      return 'Khảo sát cho lịch hẹn này đã tồn tại.';
    }
    if (msg.includes('APPOINTMENT_ALREADY_TERMINAL:')) {
      return 'Lịch hẹn đã ở trạng thái kết thúc hoặc bị hủy, không thể hoàn tất khảo sát.';
    }
    if (msg.includes('APPOINTMENT_NOT_FOUND:')) {
      return 'Không tìm thấy thông tin lịch hẹn khảo sát.';
    }
    if (msg.includes('APPOINTMENT_TYPE_NOT_SURVEY:')) {
      return 'Lịch hẹn không phải là lịch khảo sát hợp lệ.';
    }
    return msg;
  }

  return fallbackMessage;
}

/**
 * Action: Kỹ thuật viên nhận lịch hẹn (ASSIGNED -> ACCEPTED)
 */
export async function acceptSurveyAppointmentAction(
  appointmentId: string
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(
      appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: true }
    );

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
      console.error('[Action Error - acceptSurveyAppointmentAction]:', updateError);
      return {
        success: false,
        message: 'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.',
      };
    }

    revalidatePath('/surveys');
    return { success: true, message: 'Đã nhận lịch khảo sát thành công.' };
  } catch (err) {
    console.error('[Action Error - acceptSurveyAppointmentAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.'
      ),
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
    const { appointment, adminClient } = await verifyAppointmentPermission(
      appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: true }
    );

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
      console.error('[Action Error - startSurveyAppointmentAction]:', updateError);
      return {
        success: false,
        message: 'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.',
      };
    }

    revalidatePath('/surveys');
    return {
      success: true,
      redirectUrl: `/surveys/${appointmentId}`,
    };
  } catch (err) {
    console.error('[Action Error - startSurveyAppointmentAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.'
      ),
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
    const { appointment, adminClient } = await verifyAppointmentPermission(
      appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: true }
    );

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
      console.error('[Action Error - cancelSurveyAppointmentAction]:', updateError);
      return {
        success: false,
        message: 'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.',
      };
    }

    revalidatePath('/surveys');
    return { success: true, message: 'Đã hủy lịch hẹn khảo sát.' };
  } catch (err) {
    console.error('[Action Error - cancelSurveyAppointmentAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.'
      ),
    };
  }
}

/**
 * Action: Tải ảnh khảo sát lên bucket 'survey-photos'
 * Cấu trúc đường dẫn canonical được server hoàn toàn kiểm soát sau verifyAppointmentPermission.
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

    if (file.size === 0) {
      return { success: false, message: 'Tệp tải lên rỗng (0 bytes).' };
    }

    if (file.size > 10 * 1024 * 1024) {
      return { success: false, message: 'Dung lượng ảnh không được vượt quá 10MB.' };
    }

    const { appointment } = await verifyAppointmentPermission(
      appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: true }
    );

    const sanitizedSlot = sanitizePhotoSlot(photoSlot);

    // Dọn dẹp ảnh cũ trong slot trước khi tải ảnh mới
    try {
      await deleteSurveyPhotosForSlot({
        companyId: appointment.company_id,
        customerId: appointment.customer_id,
        appointmentId: appointment.id,
        photoSlot: sanitizedSlot,
      });
    } catch {
      // Non-blocking cleanup
    }

    const arrayBuffer = await file.arrayBuffer();
    const result = await uploadSurveyPhotoToStorage({
      fileBuffer: Buffer.from(arrayBuffer),
      companyId: appointment.company_id,
      customerId: appointment.customer_id,
      appointmentId: appointment.id,
      photoSlot: sanitizedSlot,
      contentType: file.type || 'image/jpeg',
    });

    return {
      success: true,
      objectPath: result.objectPath,
      signedUrl: result.signedUrl,
      message: 'Tải ảnh thành công.',
    };
  } catch (err) {
    console.error('[Action Error - uploadSurveyPhotoAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Thao tác tải lên hình ảnh thất bại do lỗi hệ thống lưu trữ. Vui lòng thử lại.'
      ),
    };
  }
}

/**
 * Action: Xóa ảnh khảo sát khỏi bucket 'survey-photos'
 * Nhận appointmentId và photoSlot, server tự sinh canonical path và xác thực quyền hạn.
 */
export async function deleteSurveyPhotoAction(
  appointmentId: string,
  photoSlot: string
): Promise<ActionResponse> {
  try {
    const { appointment } = await verifyAppointmentPermission(
      appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: true }
    );

    const sanitizedSlot = sanitizePhotoSlot(photoSlot);

    await deleteSurveyPhotosForSlot({
      companyId: appointment.company_id,
      customerId: appointment.customer_id,
      appointmentId: appointment.id,
      photoSlot: sanitizedSlot,
    });

    return { success: true, message: 'Đã xóa ảnh.' };
  } catch (err) {
    console.error('[Action Error - deleteSurveyPhotoAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Thao tác xóa hình ảnh thất bại do lỗi hệ thống lưu trữ. Vui lòng thử lại.'
      ),
    };
  }
}

/**
 * Action: Làm mới signed URL cho ảnh khảo sát (hết hạn sau 3600s)
 * Nhận appointmentId và photoSlot, server tìm file thực tế hoặc tự sinh canonical path an toàn.
 */
export async function refreshPhotoSignedUrlAction(
  appointmentId: string,
  photoSlot: string
): Promise<{ success: boolean; signedUrl?: string; message?: string }> {
  try {
    const { appointment } = await verifyAppointmentPermission(
      appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: false }
    );

    const sanitizedSlot = sanitizePhotoSlot(photoSlot);

    const objectPath = await findSurveyPhotoPathForSlot({
      companyId: appointment.company_id,
      customerId: appointment.customer_id,
      appointmentId: appointment.id,
      photoSlot: sanitizedSlot,
    });

    if (!objectPath) {
      return { success: false, message: 'Không tìm thấy ảnh của vị trí này.' };
    }

    const signedUrl = await getSurveyPhotoSignedUrl(objectPath, 3600);
    return {
      success: !!signedUrl,
      signedUrl: signedUrl || undefined,
      message: signedUrl ? 'Làm mới URL thành công.' : 'Không thể tạo đường dẫn xem trước.',
    };
  } catch (err) {
    console.error('[Action Error - refreshPhotoSignedUrlAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Lỗi hệ thống khi làm mới URL ảnh. Vui lòng thử lại sau.'
      ),
    };
  }
}

export interface CompleteSurveyActionResponse {
  success: boolean;
  message?: string;
  surveyId?: string;
  missingFields?: string[];
  errors?: Record<string, string>;
  redirectUrl?: string;
  isExisting?: boolean;
}

/**
 * Action: Kỹ thuật viên chốt hoàn tất khảo sát & đồng bộ dữ liệu kỹ thuật cho TV7
 */
export async function completeSurveyAction(
  input: import('../../../features/survey/types/survey').CompleteSurveyInput
): Promise<CompleteSurveyActionResponse> {
  try {
    const { actor } = await verifyAppointmentPermission(
      input.appointmentId,
      ['BOSS_ADMIN', 'TECHNICIAN'],
      { isMutation: true }
    );

    const { completeSurvey, validateSurveyCompletionGate } = await import(
      '../../../features/survey/services/survey.service'
    );

    const validation = validateSurveyCompletionGate(input);
    if (!validation.isValid) {
      return {
        success: false,
        message: 'Dữ liệu khảo sát chưa đạt yêu cầu kỹ thuật.',
        missingFields: validation.missingFields,
        errors: validation.errors,
      };
    }

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
      message: result.isExisting
        ? 'Khảo sát cho lịch hẹn này đã được ghi nhận trước đó.'
        : 'Khảo sát đã hoàn tất. Dữ liệu đã sẵn sàng cho bộ phận tính giá.',
      surveyId: result.surveyId,
      isExisting: result.isExisting,
      redirectUrl: '/surveys',
    };
  } catch (err) {
    console.error('[Action Error - completeSurveyAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Không thể hoàn tất khảo sát do lỗi hệ thống. Dữ liệu đã được bảo toàn an toàn.'
      ),
    };
  }
}

