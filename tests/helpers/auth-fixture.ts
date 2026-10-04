import type { SupabaseClient } from '@supabase/supabase-js';

export interface ReconcileAuthUserConfig {
  email: string;
  password?: string;
  fullName?: string;
  companyId: string;
  role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN';
  status?: 'ACTIVE' | 'INACTIVE';
}

/**
 * Reconcile deterministic test user account, user profile, and company membership.
 * If user exists, reuses canonical user ID and updates password/profile/membership.
 * If user does not exist, creates the user, profile, and membership idempotently.
 */
export async function reconcileAuthUserFixture(
  adminClient: SupabaseClient,
  config: ReconcileAuthUserConfig
): Promise<string> {
  const password = config.password || 'TestPassword123!';
  const fullName = config.fullName || 'Test User';
  const status = config.status || 'ACTIVE';

  // 1. Find or create user
  const { data: list } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
  const existing = list?.users.find((u) => u.email === config.email);

  let userId: string;
  if (!existing) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email: config.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) {
      throw new Error(`Failed to create test user ${config.email}: ${error?.message}`);
    }
    userId = data.user.id;
  } else {
    userId = existing.id;
    await adminClient.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
  }

  // 2. Upsert user profile
  const { error: profileErr } = await adminClient.from('user_profiles').upsert(
    {
      id: userId,
      full_name: fullName,
      status: 'ACTIVE',
    },
    { onConflict: 'id' }
  );
  if (profileErr) {
    throw new Error(`Failed to upsert profile for ${config.email}: ${profileErr.message}`);
  }

  // 3. Reconcile company membership
  const { error: memberErr } = await adminClient.from('company_members').upsert(
    {
      company_id: config.companyId,
      user_id: userId,
      role: config.role,
      status,
    },
    { onConflict: 'company_id,user_id' }
  );
  if (memberErr) {
    throw new Error(`Failed to reconcile company membership for ${config.email}: ${memberErr.message}`);
  }

  return userId;
}

/**
 * Clean up ephemeral auth users by ID in finally blocks.
 */
export async function cleanupEphemeralAuthUsers(
  adminClient: SupabaseClient,
  userIds: string[]
): Promise<void> {
  for (const uid of userIds) {
    if (!uid) continue;
    try {
      await adminClient.auth.admin.deleteUser(uid);
    } catch {}
  }
}
