'use server';

import { createClient } from '../../../lib/supabase/server';
import { getActorContext } from '../../../lib/auth/context';
import { APPLICATION_ROLES } from '../../../shared/constants/roles';

export interface LoginResult {
  success: boolean;
  error?: string;
  redirectTo?: string;
}

/**
 * Server Action: Đăng nhập Email & Mật khẩu
 *
 * Rules (AUTH_DESIGN.md Section 8 & Section 15):
 * 1. Authenticate with Supabase Auth (signInWithPassword).
 * 2. Return generic failure message to avoid user enumeration.
 * 3. Validate user_profiles.status === 'ACTIVE'. If not active, sign out immediately.
 * 4. Validate company_members.status === 'ACTIVE'. If not active, sign out immediately.
 * 5. Resolve proper destination route according to role (BOSS_ADMIN, SALE, TECHNICIAN).
 */
export async function loginAction(formData: FormData): Promise<LoginResult> {
  const email = (formData.get('email') as string)?.trim();
  const password = formData.get('password') as string;

  if (!email || !password) {
    return {
      success: false,
      error: 'Vui lòng nhập đầy đủ email và mật khẩu.',
    };
  }

  const supabase = await createClient();

  // 1. Supabase Auth credential verification
  const { data: authData, error: authError } =
    await supabase.auth.signInWithPassword({
      email,
      password,
    });

  if (authError || !authData.user) {
    // Generic error to prevent account enumeration
    return {
      success: false,
      error: 'Email hoặc mật khẩu không chính xác.',
    };
  }

  // 2. Application Authorization verification
  // A valid JWT alone is NEVER sufficient for business CRM access!
  const actor = await getActorContext(undefined, supabase);

  if (!actor || actor.profileStatus !== 'ACTIVE') {
    await supabase.auth.signOut();
    return {
      success: false,
      error: 'Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ quản trị viên.',
    };
  }

  if (!actor.companyId || actor.membershipStatus !== 'ACTIVE') {
    await supabase.auth.signOut();
    return {
      success: false,
      error: 'Bạn không có quyền truy cập vào tổ chức này.',
    };
  }

  // 3. Resolve destination route
  let destination = '/crm';
  if (actor.role === APPLICATION_ROLES.BOSS_ADMIN) {
    destination = '/admin';
  } else if (actor.role === APPLICATION_ROLES.TECHNICIAN) {
    destination = '/field';
  }

  return {
    success: true,
    redirectTo: destination,
  };
}
