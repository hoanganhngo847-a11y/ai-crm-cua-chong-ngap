import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '../supabase/server';

export interface MfaAssuranceState {
  currentLevel: 'aal1' | 'aal2';
  nextLevel: 'aal1' | 'aal2';
  isEnrolled: boolean;
  needsAal2Upgrade: boolean;
}

export interface TotpEnrollmentData {
  factorId: string;
  qrCode: string;
  secret: string;
  uri: string;
}

/**
 * Resolves the MFA Assurance Level and enrollment status for the current session.
 * Used to enforce AUTH DECISION 01: BOSS_ADMIN requires AAL2.
 */
export async function getMfaAssuranceState(
  supabase: SupabaseClient
): Promise<MfaAssuranceState> {
  try {
    const { data: aalData, error: aalError } =
      await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

    if (aalError || !aalData) {
      return {
        currentLevel: 'aal1',
        nextLevel: 'aal1',
        isEnrolled: false,
        needsAal2Upgrade: false,
      };
    }

    const currentLevel = (aalData.currentLevel as 'aal1' | 'aal2') || 'aal1';
    const nextLevel = (aalData.nextLevel as 'aal1' | 'aal2') || 'aal1';

    // Check factor enrollment
    let isEnrolled = false;
    const { data: factorsData, error: factorsError } =
      await supabase.auth.mfa.listFactors();

    if (!factorsError && factorsData) {
      const verifiedTotp = factorsData.totp?.some(
        (f) => f.status === 'verified'
      );
      isEnrolled = Boolean(verifiedTotp);
    }

    const needsAal2Upgrade = currentLevel !== 'aal2' && isEnrolled;

    return {
      currentLevel,
      nextLevel,
      isEnrolled,
      needsAal2Upgrade,
    };
  } catch {
    return {
      currentLevel: 'aal1',
      nextLevel: 'aal1',
      isEnrolled: false,
      needsAal2Upgrade: false,
    };
  }
}

/**
 * Retrieves the ID of the verified enrolled TOTP factor for the current user, if any.
 */
export async function getEnrolledTotpFactorId(
  client?: SupabaseClient
): Promise<string | null> {
  const supabase = client || (await createServerClient());
  const { data: factorsData, error: factorsError } =
    await supabase.auth.mfa.listFactors();

  if (factorsError || !factorsData) {
    return null;
  }

  const verified = factorsData.totp?.find((f) => f.status === 'verified');
  return verified ? verified.id : null;
}

/**
 * Enrolls a new TOTP MFA factor for the currently authenticated user.
 *
 * Security:
 * - Requires authenticated user session.
 * - Secret is returned ONLY to the intended enrollment caller.
 * - Secret is NEVER logged and NEVER persisted in application DB.
 */
export async function enrollTotpFactor(
  client?: SupabaseClient,
  friendlyName: string = 'Boss Authenticator'
): Promise<TotpEnrollmentData> {
  const supabase = client || (await createServerClient());

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('Yêu cầu đăng nhập để kích hoạt xác thực hai yếu tố.');
  }

  // Clean up existing unverified or duplicate friendly-name factors
  try {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    if (factors?.totp) {
      for (const factor of factors.totp) {
        if ((factor.status as string) === 'unverified' || factor.friendly_name === friendlyName) {
          await supabase.auth.mfa.unenroll({ factorId: factor.id });
        }
      }
    }
  } catch {
    // Ignore error during cleanup
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    issuer: 'AI CRM Cua Chong Ngap',
    friendlyName,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Không thể khởi tạo TOTP MFA.');
  }

  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    uri: data.totp.uri,
  };
}

/**
 * Challenges and verifies a 6-digit TOTP code against Supabase Auth.
 * Upgrades session assurance to currentLevel = 'aal2'.
 *
 * Security:
 * - Requires authenticated user session.
 * - Factor must belong to authenticated user.
 */
export async function challengeAndVerifyTotp(
  factorId: string,
  code: string,
  client?: SupabaseClient
): Promise<{ success: boolean; currentLevel: 'aal1' | 'aal2' }> {
  const supabase = client || (await createServerClient());

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('Yêu cầu đăng nhập để xác thực mã TOTP.');
  }

  const trimmedCode = code?.trim();
  if (!trimmedCode || trimmedCode.length !== 6) {
    throw new Error('Mã TOTP phải gồm đúng 6 chữ số.');
  }

  // 1. Create Challenge
  const { data: challengeData, error: challengeError } =
    await supabase.auth.mfa.challenge({ factorId });

  if (challengeError || !challengeData) {
    throw new Error(challengeError?.message || 'Không thể tạo yêu cầu xác thực TOTP.');
  }

  // 2. Verify Code
  const { data: verifyData, error: verifyError } =
    await supabase.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code: trimmedCode,
    });

  if (verifyError || !verifyData) {
    throw new Error(verifyError?.message || 'Mã xác thực TOTP không chính xác hoặc đã hết hạn.');
  }

  const aalState = await getMfaAssuranceState(supabase);

  return {
    success: true,
    currentLevel: aalState.currentLevel,
  };
}

/**
 * Unenrolls an existing MFA factor for the currently authenticated user.
 */
export async function unenrollTotpFactor(
  factorId: string,
  client?: SupabaseClient
): Promise<{ success: boolean }> {
  const supabase = client || (await createServerClient());

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new Error('Yêu cầu đăng nhập.');
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId });

  if (error) {
    throw new Error(error.message || 'Không thể hủy đăng ký factor MFA.');
  }

  return { success: true };
}
