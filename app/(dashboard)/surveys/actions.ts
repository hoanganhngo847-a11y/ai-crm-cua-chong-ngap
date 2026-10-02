'use server';

import { authorizeSurveyAppointment } from '../../../features/survey/services/access.service';
import { ACTIVE_SURVEY_ASSIGNMENT_STATUSES } from '../../../features/survey/constants/access';
import { revalidatePath } from 'next/cache';
import {
  uploadSurveyPhotoToStorage,
  deleteSurveyPhotosForSlot,
  getSurveyPhotoSignedUrl,
} from '../../../features/survey/services/storage-upload.service';

export interface ActionResponse {
  success: boolean;
  message?: string;
  redirectUrl?: string;
}

export interface UploadPhotoActionResponse {
  success: boolean;
  signedUrl?: string;
  message?: string;
}

async function verifyAppointmentPermission(
  appointmentId: string,
  options: { isMutation?: boolean; userClient?: import('@supabase/supabase-js').SupabaseClient } = {},
) {
  return authorizeSurveyAppointment(appointmentId, options.isMutation, options.userClient);
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
    msg.includes('INVALID_PREDECESSOR_STATE') ||
    msg.includes('INVALID_COMPLETED_BY') ||
    msg.includes('APPOINTMENT_NOT_FOUND') ||
    msg.includes('APPOINTMENT_TYPE_NOT_SURVEY') ||
    msg.includes('Người được phân công phải là kỹ thuật viên') ||
    msg.includes('Không tìm thấy hồ sơ khách hàng') ||
    msg.includes('Khách hàng không thuộc') ||
    msg.includes('Doanh nghiệp không khớp') ||
    msg.includes('POLICY_CONFIGURATION_ERROR') ||
    msg.includes('RESOURCE_NOT_FOUND') ||
    msg.includes('CHECK_VIOLATION') ||
    msg.includes('Thời gian khảo sát') ||
    msg.includes('Địa chỉ khảo sát') ||
    msg.includes('Kỹ thuật viên phụ trách')
  ) {
    if (msg.includes('SURVEY_ALREADY_EXISTS:')) {
      return 'Khảo sát cho lịch hẹn này đã tồn tại.';
    }
    if (msg.includes('APPOINTMENT_ALREADY_TERMINAL:')) {
      return 'Lịch hẹn đã ở trạng thái kết thúc hoặc bị hủy, không thể hoàn tất khảo sát.';
    }
    if (msg.includes('INVALID_PREDECESSOR_STATE:')) {
      return 'Lịch hẹn chưa ở trạng thái đang thực hiện (IN_PROGRESS/ACCEPTED), không thể hoàn tất khảo sát.';
    }
    if (msg.includes('INVALID_COMPLETED_BY:')) {
      return 'Người thực hiện khảo sát không phải là nhân sự hợp lệ của doanh nghiệp.';
    }
    if (msg.includes('APPOINTMENT_NOT_FOUND:')) {
      return 'Không tìm thấy thông tin lịch hẹn khảo sát.';
    }
    if (msg.includes('APPOINTMENT_TYPE_NOT_SURVEY:')) {
      return 'Lịch hẹn không phải là lịch khảo sát hợp lệ.';
    }
    if (msg.includes('POLICY_CONFIGURATION_ERROR:')) {
      return 'Chưa cấu hình chính sách giá hiệu lực cho doanh nghiệp.';
    }
    return msg;
  }

  return fallbackMessage;
}

/**
 * Action: Kỹ thuật viên nhận lịch hẹn (ASSIGNED -> ACCEPTED)
 * Conditional write: Chỉ cập nhật khi status hiện tại là 'ASSIGNED'
 */
export async function acceptSurveyAppointmentAction(
  appointmentId: string,
  options?: { userClient?: import('@supabase/supabase-js').SupabaseClient }
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(
      appointmentId,
      { isMutation: true, userClient: options?.userClient }
    );

    if (appointment.status !== 'ASSIGNED') {
      return {
        success: false,
        message: 'Lịch hẹn không ở trạng thái chờ nhận việc (ASSIGNED).',
      };
    }

    const { data: updatedRow, error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'ACCEPTED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId)
      .eq('company_id', appointment.company_id)
      .eq('assignee_id', appointment.assignee_id)
      .eq('status', 'ASSIGNED')
      .select('id')
      .maybeSingle();

    if (updateError) {
      console.error('[Action Error - acceptSurveyAppointmentAction]:', updateError);
      return {
        success: false,
        message: 'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.',
      };
    }

    if (!updatedRow) {
      return {
        success: false,
        message: 'Không thể nhận việc: Lịch hẹn không còn ở trạng thái chờ nhận việc (ASSIGNED) hoặc đã bị thay đổi.',
      };
    }

    try {
      revalidatePath('/surveys');
    } catch {
      // Non-fatal outside Next.js request context
    }
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
 * Conditional write: Chỉ cập nhật khi status là ASSIGNED hoặc ACCEPTED
 */
export async function startSurveyAppointmentAction(
  appointmentId: string,
  options?: { userClient?: import('@supabase/supabase-js').SupabaseClient }
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(
      appointmentId,
      { isMutation: true, userClient: options?.userClient }
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

    const { data: updatedRow, error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'IN_PROGRESS',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId)
      .eq('company_id', appointment.company_id)
      .eq('assignee_id', appointment.assignee_id)
      .in('status', ['ASSIGNED', 'ACCEPTED'])
      .select('id')
      .maybeSingle();

    if (updateError) {
      console.error('[Action Error - startSurveyAppointmentAction]:', updateError);
      return {
        success: false,
        message: 'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.',
      };
    }

    if (!updatedRow) {
      return {
        success: false,
        message: 'Không thể bắt đầu đo: Lịch hẹn không ở trạng thái hợp lệ hoặc đã bị thay đổi.',
      };
    }

    try {
      revalidatePath('/surveys');
    } catch {
      // Non-fatal outside Next.js request context
    }
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
 * Conditional write: Chỉ cho phép hủy khi status thuộc ASSIGNED, ACCEPTED, IN_PROGRESS
 */
export async function cancelSurveyAppointmentAction(
  appointmentId: string,
  options?: { userClient?: import('@supabase/supabase-js').SupabaseClient }
): Promise<ActionResponse> {
  try {
    const { appointment, adminClient } = await verifyAppointmentPermission(
      appointmentId,
      { isMutation: true, userClient: options?.userClient }
    );

    if (appointment.status === 'COMPLETED') {
      return {
        success: false,
        message: 'Không thể hủy lịch hẹn đã hoàn thành khảo sát.',
      };
    }

    const { data: updatedRow, error: updateError } = await adminClient
      .from('appointments')
      .update({
        status: 'CANCELLED',
        updated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId)
      .eq('company_id', appointment.company_id)
      .eq('assignee_id', appointment.assignee_id)
      .in('status', [...ACTIVE_SURVEY_ASSIGNMENT_STATUSES])
      .select('id')
      .maybeSingle();

    if (updateError) {
      console.error('[Action Error - cancelSurveyAppointmentAction]:', updateError);
      return {
        success: false,
        message: 'Không thể cập nhật trạng thái lịch hẹn. Vui lòng thử lại sau.',
      };
    }

    if (!updatedRow) {
      return {
        success: false,
        message: 'Không thể hủy lịch hẹn: Lịch hẹn đã hoàn thành hoặc trạng thái hiện tại không cho phép hủy.',
      };
    }

    try {
      revalidatePath('/surveys');
    } catch {
      // Non-fatal outside Next.js request context
    }
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

    const arrayBuffer = await file.arrayBuffer();
    const result = await uploadSurveyPhotoToStorage({
      fileBuffer: Buffer.from(arrayBuffer), appointmentId, photoSlot,
    });

    return {
      success: true,
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
    await deleteSurveyPhotosForSlot(appointmentId, photoSlot);

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
    const signedUrl = await getSurveyPhotoSignedUrl(appointmentId, photoSlot);
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
    const { executeSurveyCompletion } = await import(
      '../../../features/survey/services/survey.service'
    );
    const result = await executeSurveyCompletion(input);

    if (!result.success) {
      return {
        success: false,
        message: result.message,
        missingFields: result.missingFields,
        errors: result.errors,
      };
    }

    try {
      revalidatePath('/surveys');
      revalidatePath(`/surveys/${input.appointmentId}`);
    } catch {
      // Non-fatal outside Next.js request context
    }

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

export interface CreateSurveyAppointmentActionResponse {
  success: boolean;
  message?: string;
  appointment?: import('../../../features/survey/types/appointment').Appointment;
}

/**
 * Action: Lên lịch khảo sát hiện trường mới dành riêng cho SALE hoặc BOSS_ADMIN.
 * Server xác thực tenant nghiêm ngặt: client company_id hoàn toàn bị bỏ qua,
 * công ty được derive trực tiếp từ membership đang hoạt động của người dùng.
 * Phân công bắt buộc phải là kỹ thuật viên (TECHNICIAN) đang hoạt động cùng công ty.
 */
export async function createSurveyAppointmentAction(
  input: {
    customerId: string;
    assigneeId: string;
    address: string;
    appointmentDate: string;
    companyId?: string;
  },
  options?: {
    userClient?: import('@supabase/supabase-js').SupabaseClient;
    adminClient?: import('@supabase/supabase-js').SupabaseClient;
  }
): Promise<CreateSurveyAppointmentActionResponse> {
  try {
    const { scheduleSurveyAppointment } = await import(
      '../../../features/survey/services/appointment.service'
    );
    const result = await scheduleSurveyAppointment(input, options);

    if (result.success && result.appointment) {
      try {
        const { revalidatePath } = await import('next/cache');
        revalidatePath('/surveys');
        revalidatePath('/customers');
        revalidatePath(`/customers/${input.customerId}`);
      } catch {
        // Revalidation is non-blocking or outside request context
      }
    }

    return result;
  } catch (err: unknown) {
    console.error('[Action Error - createSurveyAppointmentAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Không thể tạo lịch hẹn khảo sát do lỗi hệ thống. Vui lòng thử lại.'
      ),
    };
  }
}

/**
 * Action: Lấy danh sách kỹ thuật viên (TECHNICIAN) đang hoạt động cùng công ty.
 * Zero-phone boundary: Tuyệt đối không trả về số điện thoại cá nhân.
 */
export async function getActiveCompanyTechniciansAction(
  options?: {
    userClient?: import('@supabase/supabase-js').SupabaseClient;
    adminClient?: import('@supabase/supabase-js').SupabaseClient;
  }
): Promise<{
  success: boolean;
  technicians?: Array<{ id: string; full_name: string }>;
  message?: string;
}> {
  try {
    const { getActorContext } = await import('../../../lib/auth/context');
    const { APPLICATION_ROLES } = await import('../../../shared/constants/roles');
    const { getActiveTechniciansForAuthorizedActor } = await import(
      '../../../features/survey/services/appointment.service'
    );
    const { createClient: createServerClient } = await import('../../../lib/supabase/server');

    const userClient = options?.userClient || (await createServerClient());
    const actor = await getActorContext(undefined, userClient);
    if (!actor || actor.profileStatus !== 'ACTIVE' || actor.membershipStatus !== 'ACTIVE') {
      return { success: false, message: 'Bạn chưa đăng nhập.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
      return { success: false, message: 'Bạn không có quyền xem danh sách kỹ thuật viên.' };
    }

    if (!actor.companyId) {
      return { success: false, message: 'Không xác định được doanh nghiệp.' };
    }

    const technicians = await getActiveTechniciansForAuthorizedActor(
      actor.companyId,
      options?.adminClient
    );

    return {
      success: true,
      technicians,
    };
  } catch (err) {
    console.error('[Action Error - getActiveCompanyTechniciansAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(err, 'Lỗi khi lấy danh sách kỹ thuật viên.'),
    };
  }
}

export interface CalculatePriceFromSurveyActionResponse {
  success: boolean;
  message?: string;
  calculationId?: string;
  status?: string;
  amount?: number | null;
  missingFields?: string[];
}

/**
 * Action: Kích hoạt tính giá tin cậy từ khảo sát đã hoàn tất (Option B - Explicit trusted Sale/Boss action).
 * Thao tác lấy dữ liệu khảo sát trực tiếp từ database qua canonical adapter,
 * áp dụng chính sách giá active của công ty và ghi nhận PriceCalculation bất biến.
 */
export async function calculatePriceFromSurveyAction(
  params: { surveyId: string },
  options?: {
    userClient?: import('@supabase/supabase-js').SupabaseClient;
  }
): Promise<CalculatePriceFromSurveyActionResponse> {
  try {
    const { getActorContext } = await import('../../../lib/auth/context');
    const { APPLICATION_ROLES } = await import('../../../shared/constants/roles');
    const { calculatePriceFromSurvey } = await import('../../../features/pricing/services');
    const { createClient: createServerClient } = await import('../../../lib/supabase/server');

    const userClient = options?.userClient || (await createServerClient());
    const actor = await getActorContext(undefined, userClient);
    if (!actor || actor.profileStatus !== 'ACTIVE' || actor.membershipStatus !== 'ACTIVE') {
      return { success: false, message: 'Bạn chưa đăng nhập.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
      return {
        success: false,
        message: 'Bạn không có quyền tính giá. Thao tác chỉ dành cho Sale hoặc Quản trị viên.',
      };
    }

    if (!actor.companyId) {
      return { success: false, message: 'Không xác định được doanh nghiệp.' };
    }

    const calcResult = await calculatePriceFromSurvey(
      {
        companyId: actor.companyId,
        surveyId: params.surveyId,
      },
      userClient
    );

    // If successfully CALCULATED, update customer stage to PRICE_CALCULATED
    if (calcResult.status === 'CALCULATED') {
      try {
        const { CustomerService } = await import('../../../features/crm/services/customer.service');
        await CustomerService.updateStage({
          customerId: calcResult.customer_id,
          companyId: actor.companyId,
          to_stage: 'PRICE_CALCULATED',
          note: `Đã tính giá từ khảo sát: ${calcResult.amount != null ? Number(calcResult.amount).toLocaleString('vi-VN') + ' đ' : 'Thành công'}`,
          actorId: actor.userId,
        });
      } catch (stErr) {
        console.warn('[Stage update non-fatal error]:', stErr);
      }
    }

    try {
      const { revalidatePath } = await import('next/cache');
      revalidatePath('/quotations');
      revalidatePath('/surveys');
      revalidatePath(`/customers/${calcResult.customer_id}`);
    } catch {
      // Revalidation non-fatal in test environment
    }

    return {
      success: true,
      calculationId: calcResult.id,
      status: calcResult.status,
      amount: calcResult.amount,
      missingFields: calcResult.missing_fields,
      message:
        calcResult.status === 'CALCULATED'
          ? `Đã tính giá thành công: ${Number(calcResult.amount).toLocaleString('vi-VN')} đ`
          : 'Dữ liệu khảo sát chưa đủ để tính giá tự động (NEED_INFO).',
    };
  } catch (err: unknown) {
    console.error('[Action Error - calculatePriceFromSurveyAction]:', err);
    return {
      success: false,
      message: normalizeSafeActionError(
        err,
        'Không thể tính giá từ khảo sát do lỗi hệ thống.'
      ),
    };
  }
}
