import 'server-only';
import { createAdminClient } from '../supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  APPLICATION_ROLES,
  type ApplicationRole,
} from '../../shared/constants/roles';
import { requireBossAdmin, AuthError } from './context';

export interface InviteMemberParams {
  email: string;
  fullName: string;
  role: ApplicationRole;
  companyId: string;
}

export interface ActivationResult {
  success: boolean;
  memberId: string;
  role: ApplicationRole;
  companyId: string;
}

/**
 * 1. Sếp mời nhân sự mới vào Company (Trusted Server Action)
 *
 * Rules (AUTH_DESIGN.md Section 4.3):
 * - Must be initiated by verified ACTIVE BOSS_ADMIN in the target company.
 * - Checks max 1 active SALE invariant before inviting if role is SALE.
 * - Calls auth.admin.inviteUserByEmail (24h expiration per AUTH DECISION 02).
 * - Trigger on_auth_user_created inserts user_profiles (status = 'ACTIVE').
 * - Inserts company_members with status = 'INACTIVE' (does not consume single active SALE slot).
 */
export async function inviteMember(
  params: InviteMemberParams,
  callerClient?: SupabaseClient
): Promise<{ userId: string; memberId: string }> {
  const { email, fullName, role, companyId } = params;

  // Allowed invite roles allowlist (AUTH_DESIGN Section 4.3)
  const ALLOWED_INVITE_ROLES: ApplicationRole[] = [
    APPLICATION_ROLES.SALE,
    APPLICATION_ROLES.TECHNICIAN,
  ];

  if (!ALLOWED_INVITE_ROLES.includes(role as ApplicationRole)) {
    throw new AuthError(
      `Vai trò được mời không hợp lệ: "${String(role)}". Quản trị viên chỉ được phép mời nhân viên Kinh doanh (SALE) hoặc Kỹ thuật viên (TECHNICIAN).`,
      400,
      'INVALID_INVITATION_ROLE'
    );
  }

  // Caller MUST be verified BOSS_ADMIN with real MFA AAL2 assurance (AUTH_DESIGN Section 19 Decision 01)
  await requireBossAdmin(companyId, { requireAal2: true }, callerClient);

  const adminClient = createAdminClient();

  // If role is SALE, verify whether an ACTIVE SALE already exists
  if (role === APPLICATION_ROLES.SALE) {
    const { data: existingSale } = await adminClient
      .from('company_members')
      .select('id')
      .eq('company_id', companyId)
      .eq('role', APPLICATION_ROLES.SALE)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (existingSale) {
      throw new AuthError(
        'Doanh nghiệp hiện đã có một nhân viên Kinh doanh (SALE) đang hoạt động. Vui lòng chuyển trạng thái SALE hiện tại sang INACTIVE trước khi mời SALE mới.',
        409,
        'ACTIVE_SALE_EXISTS'
      );
    }
  }

  // 1. Create auth user with invite
  const { data: inviteData, error: inviteError } =
    await adminClient.auth.admin.inviteUserByEmail(email, {
      data: {
        full_name: fullName,
      },
    });

  if (inviteError || !inviteData?.user) {
    throw new AuthError(
      inviteError?.message || 'Không thể gửi lời mời tham gia.',
      500,
      'INVITE_FAILED'
    );
  }

  const newUserId = inviteData.user.id;

  // 2. Insert initial INACTIVE membership
  const { data: member, error: memberError } = await adminClient
    .from('company_members')
    .insert({
      company_id: companyId,
      user_id: newUserId,
      role,
      status: 'INACTIVE',
    })
    .select('id')
    .single();

  if (memberError || !member) {
    throw new AuthError(
      memberError?.message || 'Không thể tạo bản ghi thành viên.',
      500,
      'MEMBERSHIP_CREATE_FAILED'
    );
  }

  return {
    userId: newUserId,
    memberId: member.id,
  };
}

/**
 * 2. Kích hoạt tư cách thành viên theo Ràng buộc Danh tính (Invitation Activation Binding)
 *
 * Rules (AUTH_DESIGN.md Section 4.3):
 * - Verified caller user_id is extracted from server-side session (getUser()).
 * - Candidate membership must match: WHERE id = candidate_member_id AND company_id = target_company_id AND user_id = verified_user_id AND status = 'INACTIVE'.
 * - Client cannot supply custom role. The role stored in database is used.
 * - If role == SALE, re-verifies single active SALE invariant.
 * - Updates status to 'ACTIVE'.
 */
export async function activateMemberMembership(
  candidateMemberId: string,
  targetCompanyId: string,
  userClient: SupabaseClient
): Promise<ActivationResult> {
  // 1. Extract verified_user_id from server session
  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();

  if (userError || !user) {
    throw new AuthError('Phiên làm việc không hợp lệ.', 401, 'UNAUTHORIZED');
  }

  const verifiedUserId = user.id;
  const adminClient = createAdminClient();

  // 2. Load candidate inactive membership bound strictly to verified_user_id
  const { data: candidateMember, error: fetchError } = await adminClient
    .from('company_members')
    .select('id, company_id, user_id, role, status, created_at')
    .eq('id', candidateMemberId)
    .eq('company_id', targetCompanyId)
    .eq('user_id', verifiedUserId)
    .eq('status', 'INACTIVE')
    .maybeSingle();

  if (fetchError || !candidateMember) {
    throw new AuthError(
      'Không tìm thấy lời mời thành viên hợp lệ cho tài khoản của bạn.',
      404,
      'INVITATION_NOT_FOUND'
    );
  }

  // 3. Verify 24-hour TTL expiration (86,400 seconds) per AUTH DECISION 02
  const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
  const createdAtMs = new Date(candidateMember.created_at).getTime();
  const nowMs = Date.now();

  if (nowMs - createdAtMs >= INVITATION_TTL_MS) {
    throw new AuthError(
      'Lời mời tham gia đã hết hạn (24 giờ). Vui lòng yêu cầu Quản trị viên gửi lại lời mời.',
      410,
      'INVITATION_EXPIRED'
    );
  }

  // 3. If role == SALE, enforce single active SALE invariant
  if (candidateMember.role === APPLICATION_ROLES.SALE) {
    const { data: activeSale } = await adminClient
      .from('company_members')
      .select('id')
      .eq('company_id', targetCompanyId)
      .eq('role', APPLICATION_ROLES.SALE)
      .eq('status', 'ACTIVE')
      .maybeSingle();

    if (activeSale) {
      throw new AuthError(
        'Doanh nghiệp đã có một nhân viên Kinh doanh (SALE) đang hoạt động. Vui lòng liên hệ Quản trị viên.',
        409,
        'ACTIVE_SALE_CONFLICT'
      );
    }
  }

  // 4. Update status to 'ACTIVE' with explicit identity binding
  const { data: updatedMember, error: updateError } = await adminClient
    .from('company_members')
    .update({ status: 'ACTIVE' })
    .eq('id', candidateMemberId)
    .eq('company_id', targetCompanyId)
    .eq('user_id', verifiedUserId)
    .eq('status', 'INACTIVE')
    .select('id, role, company_id')
    .single();

  if (updateError || !updatedMember) {
    throw new AuthError('Không thể kích hoạt tư cách thành viên.', 500, 'ACTIVATION_FAILED');
  }

  return {
    success: true,
    memberId: updatedMember.id,
    role: updatedMember.role as ApplicationRole,
    companyId: updatedMember.company_id,
  };
}
