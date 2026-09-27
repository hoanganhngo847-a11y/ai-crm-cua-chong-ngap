'use server';

import { redirect } from 'next/navigation';
import { createClient } from '../../lib/supabase/server';
import {
  requireAuthenticatedUser,
  requireBossAdmin,
  AuthError,
} from '../../lib/auth/context';
import {
  inviteMember,
  activateMemberMembership,
  type InviteMemberParams,
} from '../../lib/auth/invitation';
import {
  enrollTotpFactor,
  challengeAndVerifyTotp,
  unenrollTotpFactor,
  getEnrolledTotpFactorId,
  type TotpEnrollmentData,
} from '../../lib/auth/mfa';
import type { ApplicationRole } from '../../shared/constants/roles';

/**
 * Server Action: Đăng xuất người dùng
 * Thu hồi phiên hiện tại trên trình duyệt và điều hướng về /login.
 */
export async function logoutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/**
 * Server Action: Người dùng tự đổi mật khẩu trong màn hình Cài đặt
 *
 * Rules (FIX 8 & AUTH DECISION 03):
 * - Bắt buộc thẩm định caller đã xác thực và đang ACTIVE qua requireAuthenticatedUser().
 * - Áp dụng scope: 'others'.
 * - Phiên hiện tại trên thiết bị đang thao tác được tiếp tục.
 * - Toàn bộ các session/thiết bị khác bị thu hồi năng lực refresh token.
 */
export async function selfChangePasswordAction(
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient();

    // 1. Independent authorization guard: Caller must be an authenticated ACTIVE user
    await requireAuthenticatedUser(supabase);

    if (!newPassword || newPassword.length < 8) {
      return {
        success: false,
        error: 'Mật khẩu mới phải có tối thiểu 8 ký tự.',
      };
    }

    const { error } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (error) {
      return {
        success: false,
        error: error.message,
      };
    }

    // 2. Thu hồi các phiên trên thiết bị khác theo AUTH DECISION 03
    await supabase.auth.signOut({ scope: 'others' });

    return { success: true };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Không thể đổi mật khẩu.',
    };
  }
}

/**
 * FIX 7: ADMIN GLOBAL REVOCATION BY USER_ID — DEFERRED / PLATFORM LIMITATION
 *
 * NOTE: The previous vulnerable action `adminRevokeSessionAction(userJwt: string)`
 * has been permanently removed because receiving target JWTs from the client/browser
 * is inherently unsafe and lacks authorization.
 *
 * Under @supabase/supabase-js v2.116.0, the Supabase Auth (GoTrue) Admin API
 * only provides `auth.admin.signOut(jwt, scope)`. There is no supported Admin API
 * to revoke sessions globally by `userId` alone without an active JWT.
 *
 * Per architecture guidelines, immediate access termination is enforced at the
 * database authorization layer:
 * Setting `company_members.status = 'INACTIVE'` or `user_profiles.status = 'INACTIVE'`
 * instantly cuts off all CRM operations and routes regardless of active JWTs.
 */

/**
 * Server Action: Mời nhân sự mới vào Company
 *
 * Rules (FIX 4, FIX 5, FIX 8):
 * - Bắt buộc thẩm định độc lập caller là BOSS_ADMIN của companyId.
 * - Bắt buộc phiên Boss đạt cấp độ bảo đảm MFA AAL2 (AUTH_DESIGN Section 19 Decision 01).
 * - Kiểm tra runtime allowlist vai trò được mời (chỉ cho phép 'SALE' hoặc 'TECHNICIAN').
 */
export async function inviteMemberAction(
  params: InviteMemberParams
): Promise<{ success: boolean; userId?: string; memberId?: string; error?: string }> {
  try {
    const supabase = await createClient();

    // Caller must be BOSS_ADMIN with AAL2
    await requireBossAdmin(params.companyId, { requireAal2: true }, supabase);

    const result = await inviteMember(params, supabase);

    return {
      success: true,
      userId: result.userId,
      memberId: result.memberId,
    };
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return {
        success: false,
        error: err.message,
      };
    }
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Không thể gửi lời mời.',
    };
  }
}

/**
 * Server Action: Kích hoạt tư cách thành viên theo lời mời
 *
 * Rules (FIX 3, FIX 8):
 * - Bắt buộc caller đã xác thực (trích xuất verified_user_id từ server session).
 * - Bắt buộc kiểm tra thời hạn lời mời 24 giờ (86,400 giây) trước khi kích hoạt.
 * - Ràng buộc danh tính chặt chẽ: candidateMember.user_id === verified_user_id.
 */
export async function activateInvitationAction(
  candidateMemberId: string,
  targetCompanyId: string
): Promise<{ success: boolean; memberId?: string; role?: ApplicationRole; error?: string }> {
  try {
    const supabase = await createClient();

    // Caller must be an authenticated user
    await requireAuthenticatedUser(supabase);

    const result = await activateMemberMembership(
      candidateMemberId,
      targetCompanyId,
      supabase
    );

    return {
      success: true,
      memberId: result.memberId,
      role: result.role,
    };
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return {
        success: false,
        error: err.message,
      };
    }
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Không thể kích hoạt tài khoản.',
    };
  }
}

/**
 * Server Action: Bắt đầu đăng ký TOTP MFA (FIX 6, FIX 8)
 *
 * Rules:
 * - Bắt buộc caller đã xác thực (requireAuthenticatedUser).
 * - Trả về QR code, secret, URI cho riêng giao diện đăng ký của người dùng đó.
 * - Không bao giờ log secret hoặc lưu vào DB.
 */
export async function enrollMfaAction(): Promise<{
  success: boolean;
  data?: TotpEnrollmentData;
  error?: string;
}> {
  try {
    const supabase = await createClient();
    await requireAuthenticatedUser(supabase);

    const data = await enrollTotpFactor(supabase);
    return { success: true, data };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Không thể khởi tạo đăng ký MFA.',
    };
  }
}

/**
 * Server Action: Thử thách và xác minh mã TOTP (FIX 6, FIX 8)
 *
 * Rules:
 * - Bắt buộc caller đã xác thực.
 * - Xác minh mã 6 chữ số hợp lệ qua Supabase Auth.
 * - Nâng cấp phiên làm việc lên AAL2.
 */
export async function verifyMfaAction(
  factorId: string,
  code: string
): Promise<{ success: boolean; currentLevel?: 'aal1' | 'aal2'; error?: string }> {
  try {
    const supabase = await createClient();
    await requireAuthenticatedUser(supabase);

    const result = await challengeAndVerifyTotp(factorId, code, supabase);
    return { success: true, currentLevel: result.currentLevel };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Mã xác minh không chính xác.',
    };
  }
}

/**
 * Server Action: Hủy đăng ký TOTP MFA (FIX 8)
 */
export async function unenrollMfaAction(
  factorId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await createClient();
    await requireAuthenticatedUser(supabase);

    await unenrollTotpFactor(factorId, supabase);
    return { success: true };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Không thể hủy đăng ký MFA.',
    };
  }
}

/**
 * Server Action: Lấy factor ID của TOTP đã kích hoạt (FIX 6, FIX 8)
 */
export async function getEnrolledFactorIdAction(): Promise<{
  success: boolean;
  factorId?: string | null;
  error?: string;
}> {
  try {
    const supabase = await createClient();
    await requireAuthenticatedUser(supabase);

    const factorId = await getEnrolledTotpFactorId(supabase);
    return { success: true, factorId };
  } catch (err: unknown) {
    const error = err as Error;
    return {
      success: false,
      error: error.message || 'Không thể lấy thông tin MFA.',
    };
  }
}
