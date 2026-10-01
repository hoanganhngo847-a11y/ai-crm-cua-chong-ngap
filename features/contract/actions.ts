'use server';

import { revalidatePath } from 'next/cache';
import { getActorContext } from '@/lib/auth/context';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import {
  generateContractForOrder,
  getContractDownloadUrl,
  signContract,
  validateSignedPdf,
  MAX_CONTRACT_PDF_SIZE_BYTES,
} from './services';

/**
 * Action: Lấy URL tải xuống hợp đồng có chữ ký thời hạn (Signed URL).
 * Allowed roles: BOSS_ADMIN, SALE.
 */
export async function getContractDownloadUrlAction(params: {
  contractId: string;
  variant?: 'generated' | 'signed';
}): Promise<{
  success: boolean;
  signedUrl?: string;
  expiresInSeconds?: number;
  error?: string;
}> {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
      return { success: false, error: 'Bạn không có quyền truy cập tệp hợp đồng.' };
    }

    const res = await getContractDownloadUrl({
      contractId: params.contractId,
      variant: params.variant || 'generated',
    });

    return {
      success: true,
      signedUrl: res.signedUrl,
      expiresInSeconds: res.expiresIn,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi tạo liên kết tải hợp đồng';
    return { success: false, error: message };
  }
}

/**
 * Action: Ký và phê duyệt hợp đồng chính thức bằng tệp PDF đã ký.
 * Allowed roles: BOSS_ADMIN ONLY.
 * Strict AAL2 MFA enforcement: fails closed if actor.aal !== 'aal2'.
 * Storage path and revision are derived server-side.
 */
export async function signContractAction(
  formData: FormData
): Promise<{
  success: boolean;
  contractId?: string;
  orderId?: string;
  status?: string;
  aalRequired?: boolean;
  error?: string;
}> {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN) {
      return {
        success: false,
        error: 'Quyền hạn bị từ chối: Chỉ Quản trị viên (Boss) mới có quyền ký duyệt hợp đồng.',
      };
    }

    if (actor.aal !== 'aal2') {
      return {
        success: false,
        aalRequired: true,
        error: 'AAL2_REQUIRED: Ký hợp đồng yêu cầu xác thực bảo mật đa yếu tố cấp độ AAL2.',
      };
    }

    const contractId = formData.get('contractId') as string | null;
    if (!contractId) {
      return { success: false, error: 'Mã hợp đồng là bắt buộc' };
    }

    const file = formData.get('file') as File | null;
    if (!file) {
      return { success: false, error: 'Vui lòng chọn tệp PDF hợp đồng đã ký' };
    }

    if (file.size > MAX_CONTRACT_PDF_SIZE_BYTES) {
      return {
        success: false,
        error: `Dung lượng tệp vượt quá giới hạn tối đa ${MAX_CONTRACT_PDF_SIZE_BYTES / (1024 * 1024)}MB`,
      };
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);

    // Validate PDF magic header %PDF-
    validateSignedPdf(pdfBuffer);

    const signRes = await signContract({
      companyId: actor.companyId,
      contractId,
      signedPdfBuffer: pdfBuffer,
    });

    revalidatePath('/contracts');
    revalidatePath('/orders');
    revalidatePath('/production');

    return {
      success: true,
      contractId: signRes.contractId,
      orderId: signRes.orderId,
      status: signRes.status,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi ký hợp đồng';
    return { success: false, error: message };
  }
}

/**
 * Action: Khởi tạo/sinh hợp đồng cho đơn hàng.
 * Allowed roles: BOSS_ADMIN, SALE.
 */
export async function generateContractAction(input: {
  orderId: string;
}): Promise<{
  success: boolean;
  contractId?: string;
  error?: string;
}> {
  try {
    const actor = await getActorContext();
    if (!actor?.companyId || !actor?.userId) {
      return { success: false, error: 'Chưa xác định danh tính hoặc tổ chức làm việc.' };
    }

    if (actor.role !== APPLICATION_ROLES.BOSS_ADMIN && actor.role !== APPLICATION_ROLES.SALE) {
      return { success: false, error: 'Bạn không có quyền khởi tạo hợp đồng.' };
    }

    const res = await generateContractForOrder({
      companyId: actor.companyId,
      orderId: input.orderId,
    });

    revalidatePath('/contracts');
    revalidatePath('/orders');

    return { success: true, contractId: res.contractId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Lỗi khi khởi tạo hợp đồng';
    return { success: false, error: message };
  }
}
