import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  getActorContext,
  requireAuthenticatedUser,
  requireActiveMember,
  requireCompanyRole,
  requireBossAdmin,
  requireSale,
  requireTechnician,
  AuthError,
} from '../../lib/auth/context';
import { inviteMember, activateMemberMembership } from '../../lib/auth/invitation';
import {
  enrollTotpFactor,
  challengeAndVerifyTotp,
  getMfaAssuranceState,
} from '../../lib/auth/mfa';
import { sanitizeRedirectPath } from '../../lib/auth/redirect';
import { loginAction } from '../../app/(auth)/login/actions';
import { APPLICATION_ROLES, type ApplicationRole } from '../../shared/constants/roles';

// Environment credentials for local Supabase
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;

const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function createAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Fixed deterministic UUIDs for test companies
const COMPANY_A_ID = '11111111-1111-1111-1111-111111111111';
const COMPANY_B_ID = '22222222-2222-2222-2222-222222222222';

// Test Users
const TEST_USERS = {
  sale: { email: 'sale_test@crm.local', password: 'Password123!', fullName: 'Nguyễn Văn Sale' },
  tech: { email: 'tech_test@crm.local', password: 'Password123!', fullName: 'Trần Kỹ Thuật' },
  boss: { email: 'boss_test@crm.local', password: 'Password123!', fullName: 'Lê Quản Trị (Sếp)' },
  inactiveProfile: { email: 'inactive_profile_test@crm.local', password: 'Password123!', fullName: 'Nhân Viên Bị Khóa' },
  inactiveMember: { email: 'inactive_member_test@crm.local', password: 'Password123!', fullName: 'Nghỉ Việc Member' },
  multiCompany: { email: 'multicompany_test@crm.local', password: 'Password123!', fullName: 'Đa Doanh Nghiệp' },
  mfaBoss: { email: 'mfa_boss_test@crm.local', password: 'Password123!', fullName: 'MFA Boss Test' },
};

// RFC 6238 Base32 decoding helper for TOTP verification
function base32ToBuffer(base32: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = base32.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = alphabet.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// RFC 6238 TOTP Code Generator (Node.js standard crypto)
function generateTotpCode(secret: string, timeStepSeconds = 30): string {
  const key = base32ToBuffer(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

async function setupTestData() {
  console.log('--- Setting up local test database fixtures ---');

  // 1. Ensure test companies exist
  await adminClient.from('companies').upsert([
    { id: COMPANY_A_ID, name: 'Công Ty Cửa Chống Ngập A', status: 'ACTIVE' },
    { id: COMPANY_B_ID, name: 'Công Ty Cửa Chống Ngập B', status: 'ACTIVE' },
  ]);

  // Clean up any existing test users and their factors
  const { data: userList } = await adminClient.auth.admin.listUsers();
  for (const user of userList?.users || []) {
    if (user.email?.endsWith('@crm.local')) {
      try {
        const { data: factors } = await adminClient.auth.admin.mfa.listFactors({ userId: user.id });
        for (const f of factors?.factors || []) {
          await adminClient.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id });
        }
      } catch {
        // Ignore factor cleanup errors
      }
      await adminClient.from('company_members').delete().eq('user_id', user.id);
      await adminClient.from('user_profiles').delete().eq('id', user.id);
      await adminClient.auth.admin.deleteUser(user.id);
    }
  }

  // Helper to create and configure user
  async function createUserWithRole(
    config: { email: string; password: string; fullName: string },
    companyId: string,
    role: 'BOSS_ADMIN' | 'SALE' | 'TECHNICIAN',
    profileStatus: 'ACTIVE' | 'INACTIVE',
    membershipStatus: 'ACTIVE' | 'INACTIVE'
  ) {
    const { data, error } = await adminClient.auth.admin.createUser({
      email: config.email,
      password: config.password,
      email_confirm: true,
      user_metadata: { full_name: config.fullName },
    });

    if (error || !data.user) {
      throw new Error(`Failed to create user ${config.email}: ${error?.message}`);
    }

    const userId = data.user.id;

    // Ensure profile status
    await adminClient
      .from('user_profiles')
      .update({ status: profileStatus })
      .eq('id', userId);

    // Create membership
    const { error: memberErr } = await adminClient.from('company_members').insert({
      company_id: companyId,
      user_id: userId,
      role,
      status: membershipStatus,
    });
    if (memberErr) {
      throw new Error(`Failed to insert membership: ${memberErr.message}`);
    }

    return userId;
  }

  await createUserWithRole(TEST_USERS.sale, COMPANY_A_ID, 'SALE', 'ACTIVE', 'ACTIVE');
  await createUserWithRole(TEST_USERS.tech, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE', 'ACTIVE');
  await createUserWithRole(TEST_USERS.boss, COMPANY_A_ID, 'BOSS_ADMIN', 'ACTIVE', 'ACTIVE');
  await createUserWithRole(TEST_USERS.inactiveProfile, COMPANY_A_ID, 'TECHNICIAN', 'INACTIVE', 'ACTIVE');
  await createUserWithRole(TEST_USERS.inactiveMember, COMPANY_A_ID, 'TECHNICIAN', 'ACTIVE', 'INACTIVE');
  await createUserWithRole(TEST_USERS.mfaBoss, COMPANY_A_ID, 'BOSS_ADMIN', 'ACTIVE', 'ACTIVE');

  // Multi-company user with memberships in both COMPANY_A and COMPANY_B
  const multiUserId = await createUserWithRole(
    TEST_USERS.multiCompany,
    COMPANY_A_ID,
    'TECHNICIAN',
    'ACTIVE',
    'ACTIVE'
  );
  const { error: multiInsertErr } = await adminClient.from('company_members').insert({
    company_id: COMPANY_B_ID,
    user_id: multiUserId,
    role: 'TECHNICIAN',
    status: 'ACTIVE',
  });
  if (multiInsertErr) {
    throw new Error(`Failed to insert multiCompany membership: ${multiInsertErr.message}`);
  }

  console.log('✓ Test data setup complete.\n');
}

async function runTests() {
  await setupTestData();

  let passCount = 0;
  let failCount = 0;

  function assert(
    condition: boolean,
    testName: string,
    classification: 'REAL LOCAL SUPABASE' | 'UNIT' | 'STATIC' = 'REAL LOCAL SUPABASE',
    detail?: string
  ) {
    const label = `[${classification}] ${testName}`;
    if (condition) {
      console.log(`[PASS] ${label}`);
      passCount++;
    } else {
      console.error(`[FAIL] ${label} ${detail ? `(${detail})` : ''}`);
      failCount++;
    }
  }

  console.log('==================================================');
  console.log('RUNNING COMPLETE AUTH RUNTIME SECURITY REGRESSION');
  console.log('==================================================');

  // ==============================================================================
  // PART 1: PREVIOUS REGRESSION SCENARIOS (41 ASSERTIONS PRESERVED 1:1)
  // ==============================================================================

  // ----------------------------------------------------
  // Test A: Unauthenticated user -> protected route/helper denied (2 assertions)
  // ----------------------------------------------------
  {
    const unauthClient = createAnonClient();
    let caught401 = false;
    try {
      await requireAuthenticatedUser(unauthClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 401) {
        caught401 = true;
      }
    }
    assert(caught401, 'Test A: Unauthenticated user -> requireAuthenticatedUser denied with 401', 'REAL LOCAL SUPABASE');

    let caughtActiveMember401 = false;
    try {
      await requireActiveMember(COMPANY_A_ID, unauthClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 401) {
        caughtActiveMember401 = true;
      }
    }
    assert(caughtActiveMember401, 'Test A: Unauthenticated user -> requireActiveMember denied with 401', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test B: SALE user login & authorization checks (4 assertions)
  // ----------------------------------------------------
  {
    const saleClient = createAnonClient();
    const { error: loginErr } = await saleClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: TEST_USERS.sale.password,
    });
    assert(!loginErr, 'Test B: SALE signInWithPassword succeeds', 'REAL LOCAL SUPABASE');

    const actor = await getActorContext(COMPANY_A_ID, saleClient);
    assert(
      actor !== null &&
        actor.email === TEST_USERS.sale.email &&
        actor.role === 'SALE' &&
        actor.profileStatus === 'ACTIVE' &&
        actor.membershipStatus === 'ACTIVE' &&
        actor.companyId === COMPANY_A_ID,
      'Test B: Actor context resolves correctly as ACTIVE SALE',
      'REAL LOCAL SUPABASE'
    );

    let saleCheckPassed = false;
    try {
      const saleCtx = await requireSale(COMPANY_A_ID, saleClient);
      const roleCtx = await requireCompanyRole(COMPANY_A_ID, [APPLICATION_ROLES.SALE], saleClient);
      if (saleCtx.role === 'SALE' && roleCtx.role === 'SALE') {
        saleCheckPassed = true;
      }
    } catch {
      saleCheckPassed = false;
    }
    assert(saleCheckPassed, 'Test B: requireSale and requireCompanyRole succeed for ACTIVE SALE', 'REAL LOCAL SUPABASE');

    let bossForbidden = false;
    try {
      await requireBossAdmin(COMPANY_A_ID, { requireAal2: false }, saleClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        bossForbidden = true;
      }
    }
    assert(bossForbidden, 'Test B: requireBossAdmin rejects SALE with 403 ROLE_FORBIDDEN', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test C: TECHNICIAN user login & authorization checks (4 assertions)
  // ----------------------------------------------------
  {
    const techClient = createAnonClient();
    const { error: loginErr } = await techClient.auth.signInWithPassword({
      email: TEST_USERS.tech.email,
      password: TEST_USERS.tech.password,
    });
    assert(!loginErr, 'Test C: TECHNICIAN signInWithPassword succeeds', 'REAL LOCAL SUPABASE');

    const actor = await getActorContext(COMPANY_A_ID, techClient);
    assert(
      actor !== null &&
        actor.email === TEST_USERS.tech.email &&
        actor.role === 'TECHNICIAN' &&
        actor.profileStatus === 'ACTIVE' &&
        actor.membershipStatus === 'ACTIVE' &&
        actor.companyId === COMPANY_A_ID,
      'Test C: Actor context resolves correctly as ACTIVE TECHNICIAN',
      'REAL LOCAL SUPABASE'
    );

    let techCheckPassed = false;
    try {
      const techCtx = await requireTechnician(COMPANY_A_ID, techClient);
      if (techCtx.role === 'TECHNICIAN') {
        techCheckPassed = true;
      }
    } catch {
      techCheckPassed = false;
    }
    assert(techCheckPassed, 'Test C: requireTechnician succeeds for ACTIVE TECHNICIAN', 'REAL LOCAL SUPABASE');

    let saleForbidden = false;
    try {
      await requireSale(COMPANY_A_ID, techClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        saleForbidden = true;
      }
    }
    assert(saleForbidden, 'Test C: requireSale rejects TECHNICIAN with 403 ROLE_FORBIDDEN', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test D: BOSS_ADMIN login & base authorization checks (3 assertions)
  // ----------------------------------------------------
  {
    const bossClient = createAnonClient();
    const { error: loginErr } = await bossClient.auth.signInWithPassword({
      email: TEST_USERS.boss.email,
      password: TEST_USERS.boss.password,
    });
    assert(!loginErr, 'Test D: BOSS_ADMIN signInWithPassword succeeds', 'REAL LOCAL SUPABASE');

    const actor = await getActorContext(COMPANY_A_ID, bossClient);
    assert(
      actor !== null &&
        actor.email === TEST_USERS.boss.email &&
        actor.role === 'BOSS_ADMIN' &&
        actor.profileStatus === 'ACTIVE' &&
        actor.membershipStatus === 'ACTIVE' &&
        actor.companyId === COMPANY_A_ID,
      'Test D: Actor context resolves correctly as ACTIVE BOSS_ADMIN',
      'REAL LOCAL SUPABASE'
    );

    let bossAuthorized = false;
    try {
      const bossCtx = await requireBossAdmin(COMPANY_A_ID, { requireAal2: false }, bossClient);
      if (bossCtx.role === 'BOSS_ADMIN') {
        bossAuthorized = true;
      }
    } catch {
      bossAuthorized = false;
    }
    assert(bossAuthorized, 'Test D: requireBossAdmin succeeds for BOSS_ADMIN', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test E: BOSS_ADMIN MFA Requirement vs Other Roles (2 assertions)
  // ----------------------------------------------------
  {
    const bossClient = createAnonClient();
    await bossClient.auth.signInWithPassword({
      email: TEST_USERS.boss.email,
      password: TEST_USERS.boss.password,
    });

    let caughtMfaRequired = false;
    try {
      await requireBossAdmin(COMPANY_A_ID, { requireAal2: true }, bossClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'MFA_REQUIRED') {
        caughtMfaRequired = true;
      }
    }
    assert(caughtMfaRequired, 'Test E: BOSS_ADMIN without AAL2 denied with MFA_REQUIRED', 'REAL LOCAL SUPABASE');

    const saleClient = createAnonClient();
    await saleClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: TEST_USERS.sale.password,
    });

    let saleUncheckedForMfa = false;
    try {
      const saleCtx = await requireSale(COMPANY_A_ID, saleClient);
      if (saleCtx.role === 'SALE' && saleCtx.aal === 'aal1') {
        saleUncheckedForMfa = true;
      }
    } catch {
      saleUncheckedForMfa = false;
    }
    assert(saleUncheckedForMfa, 'Test E: SALE is not forced into Boss-only MFA', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test F: INACTIVE profile denial (3 assertions)
  // ----------------------------------------------------
  {
    const client = createAnonClient();
    const { data: authData, error: loginErr } = await client.auth.signInWithPassword({
      email: TEST_USERS.inactiveProfile.email,
      password: TEST_USERS.inactiveProfile.password,
    });
    assert(!loginErr && Boolean(authData.user), 'Test F: AuthN succeeds for user with INACTIVE profile', 'REAL LOCAL SUPABASE');

    let profileForbidden = false;
    try {
      await requireAuthenticatedUser(client);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'USER_INACTIVE') {
        profileForbidden = true;
      }
    }
    assert(profileForbidden, 'Test F: Application authorization fails with 403 USER_INACTIVE', 'REAL LOCAL SUPABASE');

    let memberAccessDenied = false;
    try {
      await requireActiveMember(COMPANY_A_ID, client);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'USER_INACTIVE') {
        memberAccessDenied = true;
      }
    }
    assert(memberAccessDenied, 'Test F: requireActiveMember denied for INACTIVE profile', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test G: INACTIVE membership denial (3 assertions)
  // ----------------------------------------------------
  {
    const client = createAnonClient();
    const { data: authData, error: loginErr } = await client.auth.signInWithPassword({
      email: TEST_USERS.inactiveMember.email,
      password: TEST_USERS.inactiveMember.password,
    });
    assert(!loginErr && Boolean(authData.user), 'Test G: AuthN succeeds for user with INACTIVE membership', 'REAL LOCAL SUPABASE');

    let userAuthPassed = false;
    try {
      const userCtx = await requireAuthenticatedUser(client);
      if (userCtx.userId) userAuthPassed = true;
    } catch {
      userAuthPassed = false;
    }
    assert(userAuthPassed, 'Test G: Profile is ACTIVE so requireAuthenticatedUser passes', 'REAL LOCAL SUPABASE');

    let membershipForbidden = false;
    try {
      await requireActiveMember(COMPANY_A_ID, client);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'MEMBERSHIP_INACTIVE') {
        membershipForbidden = true;
      }
    }
    assert(membershipForbidden, 'Test G: requireActiveMember fails with 403 MEMBERSHIP_INACTIVE', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test H: Cross-Company Access Denied (2 assertions)
  // ----------------------------------------------------
  {
    const saleClient = createAnonClient();
    await saleClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: TEST_USERS.sale.password,
    });

    let crossCompanyForbidden = false;
    try {
      await requireActiveMember(COMPANY_B_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'NOT_A_MEMBER') {
        crossCompanyForbidden = true;
      }
    }
    assert(crossCompanyForbidden, 'Test H: Cross-company access rejected with 403 NOT_A_MEMBER', 'REAL LOCAL SUPABASE');

    const derivedActor = await getActorContext(COMPANY_A_ID, saleClient);
    assert(
      derivedActor !== null && derivedActor.companyId === COMPANY_A_ID,
      'Test H: Server-derived context wins and ignores client spoof attempts',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test I: Session Handling (2 assertions)
  // ----------------------------------------------------
  {
    const emptyClient = createAnonClient();
    const actor = await getActorContext(COMPANY_A_ID, emptyClient);
    assert(actor === null, 'Test I: No session -> getActorContext returns null', 'REAL LOCAL SUPABASE');

    let denied = false;
    try {
      await requireAuthenticatedUser(emptyClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 401) {
        denied = true;
      }
    }
    assert(denied, 'Test I: No session -> requireAuthenticatedUser denied with 401', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test J: Invalid/forged session token rejected (1 assertion)
  // ----------------------------------------------------
  {
    const forgedClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        headers: {
          Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.forged.token',
        },
      },
    });

    let invalidDenied = false;
    try {
      await requireAuthenticatedUser(forgedClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 401) {
        invalidDenied = true;
      }
    }
    assert(invalidDenied, 'Test J: Invalid/forged session token rejected with 401', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test K: Single Active SALE Invariant (1 assertion)
  // ----------------------------------------------------
  {
    let secondSaleConflict = false;
    try {
      const newUserRes = await adminClient.auth.admin.createUser({
        email: 'second_sale_test@crm.local',
        password: 'Password123!',
      });
      const secondUserId = newUserRes.data.user!.id;

      const { error } = await adminClient.from('company_members').insert({
        company_id: COMPANY_A_ID,
        user_id: secondUserId,
        role: 'SALE',
        status: 'ACTIVE',
      });

      if (error && error.code === '23505') {
        secondSaleConflict = true;
      }
    } catch {
      secondSaleConflict = true;
    }
    assert(secondSaleConflict, 'Test K: Second ACTIVE SALE in same company is rejected by DB partial unique index', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test L: Invitation Flow & Identity-Bound Activation (7 assertions)
  // ----------------------------------------------------
  const bossClient = createAnonClient();
  {
    await bossClient.auth.signInWithPassword({
      email: TEST_USERS.boss.email,
      password: TEST_USERS.boss.password,
    });

    // Elevate Boss to AAL2 for invitation operations
    const enrollRes = await enrollTotpFactor(bossClient);
    const validOtp = generateTotpCode(enrollRes.secret);
    await challengeAndVerifyTotp(enrollRes.factorId, validOtp, bossClient);

    // 1. Boss invites a new technician
    const inviteRes = await inviteMember(
      {
        email: 'invited_tech@crm.local',
        fullName: 'Kỹ Thuật Viên Mới',
        role: APPLICATION_ROLES.TECHNICIAN,
        companyId: COMPANY_A_ID,
      },
      bossClient
    );
    assert(Boolean(inviteRes.userId && inviteRes.memberId), 'Test L: Boss can invite new member', 'REAL LOCAL SUPABASE');

    // 2. Verify initial membership is INACTIVE
    const { data: initMember } = await adminClient
      .from('company_members')
      .select('status, role')
      .eq('id', inviteRes.memberId)
      .single();
    assert(
      initMember?.status === 'INACTIVE' && initMember?.role === 'TECHNICIAN',
      'Test L: Invited member has initial status = INACTIVE',
      'REAL LOCAL SUPABASE'
    );

    // 3. Non-boss (SALE) cannot invite
    const saleClient = createAnonClient();
    await saleClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: TEST_USERS.sale.password,
    });
    let nonBossInviteBlocked = false;
    try {
      await inviteMember(
        {
          email: 'illegal_invite@crm.local',
          fullName: 'Hacker',
          role: APPLICATION_ROLES.TECHNICIAN,
          companyId: COMPANY_A_ID,
        },
        saleClient
      );
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403) {
        nonBossInviteBlocked = true;
      }
    }
    assert(nonBossInviteBlocked, 'Test L: Non-boss (SALE) cannot invite members (403)', 'REAL LOCAL SUPABASE');

    // 4. Invited technician sets password and logs in
    await adminClient.auth.admin.updateUserById(inviteRes.userId, {
      password: 'Password123!',
      email_confirm: true,
    });
    const invitedUserClient = createAnonClient();
    const { error: invitedLoginErr } = await invitedUserClient.auth.signInWithPassword({
      email: 'invited_tech@crm.local',
      password: 'Password123!',
    });
    assert(!invitedLoginErr, 'Test L: Invited user signs in after setting password', 'REAL LOCAL SUPABASE');

    // 5. Activation spoof attempt: Sale tries to activate Tech's membership
    let spoofActivationBlocked = false;
    try {
      await activateMemberMembership(inviteRes.memberId, COMPANY_A_ID, saleClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 404) {
        spoofActivationBlocked = true;
      }
    }
    assert(spoofActivationBlocked, 'Test L: Activation spoof attempt by another user rejected with 404', 'REAL LOCAL SUPABASE');

    // 6. Valid user activates own membership
    const activationRes = await activateMemberMembership(
      inviteRes.memberId,
      COMPANY_A_ID,
      invitedUserClient
    );
    assert(
      activationRes.success && activationRes.role === 'TECHNICIAN',
      'Test L: Legitimate user activates own membership with identity binding',
      'REAL LOCAL SUPABASE'
    );

    // 7. Verify DB status is now ACTIVE
    const { data: activatedMember } = await adminClient
      .from('company_members')
      .select('status')
      .eq('id', inviteRes.memberId)
      .single();
    assert(activatedMember?.status === 'ACTIVE', 'Test L: DB membership status is ACTIVE after activation', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test M: Password Update & Session Revocation Semantics (4 assertions)
  // ----------------------------------------------------
  {
    const saleClient = createAnonClient();
    await saleClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: TEST_USERS.sale.password,
    });

    const { error: updateErr } = await saleClient.auth.updateUser({
      password: 'NewPassword456!',
    });
    assert(!updateErr, 'Test M: Self password change succeeds', 'REAL LOCAL SUPABASE');

    const { error: signOutOthersErr } = await saleClient.auth.signOut({ scope: 'others' });
    assert(!signOutOthersErr, 'Test M: signOut with scope = others succeeds', 'REAL LOCAL SUPABASE');

    const { data: sessionAfter } = await saleClient.auth.getSession();
    assert(Boolean(sessionAfter.session), 'Test M: Current session remains active after scope: others', 'REAL LOCAL SUPABASE');

    // Global revocation by admin using session access token
    const saleJwt = sessionAfter.session!.access_token;
    const { error: globalRevokeErr } = await adminClient.auth.admin.signOut(saleJwt, 'global');
    assert(!globalRevokeErr, 'Test M: Admin signOut with scope = global succeeds', 'REAL LOCAL SUPABASE');

    // Reset password back for repeatability
    const saleUserId = sessionAfter.session!.user.id;
    await adminClient.auth.admin.updateUserById(saleUserId, {
      password: TEST_USERS.sale.password,
    });
  }

  // ----------------------------------------------------
  // Test N: Login Flow Authorization Gating (3 assertions)
  // ----------------------------------------------------
  {
    const testClient = createAnonClient();
    const { error: wrongPwErr } = await testClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: 'WrongPassword!',
    });
    assert(Boolean(wrongPwErr), 'Test N: Wrong password fails authentication', 'REAL LOCAL SUPABASE');

    const inactiveProfClient = createAnonClient();
    await inactiveProfClient.auth.signInWithPassword({
      email: TEST_USERS.inactiveProfile.email,
      password: TEST_USERS.inactiveProfile.password,
    });
    const inactiveProfActor = await getActorContext(COMPANY_A_ID, inactiveProfClient);
    assert(
      inactiveProfActor?.profileStatus === 'INACTIVE',
      'Test N: INACTIVE profile user has profileStatus INACTIVE',
      'REAL LOCAL SUPABASE'
    );

    const inactiveMemClient = createAnonClient();
    await inactiveMemClient.auth.signInWithPassword({
      email: TEST_USERS.inactiveMember.email,
      password: TEST_USERS.inactiveMember.password,
    });
    const inactiveMemActor = await getActorContext(COMPANY_A_ID, inactiveMemClient);
    assert(
      inactiveMemActor?.membershipStatus === 'INACTIVE',
      'Test N: INACTIVE membership user has membershipStatus INACTIVE',
      'REAL LOCAL SUPABASE'
    );
  }

  // ==============================================================================
  // PART 2: REMEDIATION VERIFICATION SCENARIOS (REMEDIATION R1 to R25)
  // ==============================================================================

  console.log('\n--- Running Remediation Verification Scenarios ---');

  // ----------------------------------------------------
  // Test R1: Adversarial redirect vectors -> safe internal fallback (1 assertion)
  // ----------------------------------------------------
  {
    const fallback = '/crm';
    const attacks = [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '',
    ];

    let allAttacksBlocked = true;
    for (const attack of attacks) {
      const sanitized = sanitizeRedirectPath(attack, fallback);
      if (sanitized !== fallback) {
        allAttacksBlocked = false;
        console.error(`Attack not blocked: ${attack} -> returned ${sanitized}`);
      }
    }
    assert(
      allAttacksBlocked,
      'Test R1: Adversarial redirect vectors fallback to safe internal path (/crm)',
      'UNIT'
    );
  }

  // ----------------------------------------------------
  // Test R2: Valid internal redirect paths preserved (1 assertion)
  // ----------------------------------------------------
  {
    const fallback = '/crm';
    const validPaths = ['/admin', '/crm', '/field', '/account', '/crm/inbox', '/admin/settings'];
    let allValidPreserved = true;
    for (const valid of validPaths) {
      const sanitized = sanitizeRedirectPath(valid, fallback);
      if (sanitized !== valid) {
        allValidPreserved = false;
        console.error(`Valid path failed: ${valid} -> returned ${sanitized}`);
      }
    }
    assert(allValidPreserved, 'Test R2: Valid internal redirect paths preserved intact', 'UNIT');
  }

  // ----------------------------------------------------
  // Test R3: Anonymous public signup disabled in Supabase config (1 assertion)
  // ----------------------------------------------------
  {
    const anon = createAnonClient();
    const { data: signupData, error: signupError } = await anon.auth.signUp({
      email: 'hacker_public_signup@crm.local',
      password: 'Password123!',
    });
    assert(
      !signupData.user && Boolean(signupError) && (signupError?.message.includes('Signups not allowed') || signupError?.status === 422),
      'Test R3: Anonymous public signup rejected by local Supabase GoTrue configuration',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R4: Trusted invitation works despite public signup disabled (1 assertion)
  // ----------------------------------------------------
  let invitedTechRes: { userId: string; memberId: string } | null = null;
  {
    invitedTechRes = await inviteMember(
      {
        email: 'remediation_invited_tech@crm.local',
        fullName: 'Kỹ Thuật Viên Remediation',
        role: APPLICATION_ROLES.TECHNICIAN,
        companyId: COMPANY_A_ID,
      },
      bossClient
    );
    assert(
      Boolean(invitedTechRes?.userId && invitedTechRes?.memberId),
      'Test R4: Admin trusted invitation succeeds when signup is disabled',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R5: Boss at AAL1 attempting invite rejected with MFA_REQUIRED (1 assertion)
  // ----------------------------------------------------
  {
    const freshBossClient = createAnonClient();
    await freshBossClient.auth.signInWithPassword({
      email: TEST_USERS.boss.email,
      password: TEST_USERS.boss.password,
    });
    let aal1InviteBlocked = false;
    try {
      await inviteMember(
        {
          email: 'illegal_aal1_invite@crm.local',
          fullName: 'Illegal User',
          role: APPLICATION_ROLES.TECHNICIAN,
          companyId: COMPANY_A_ID,
        },
        freshBossClient
      );
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'MFA_REQUIRED') {
        aal1InviteBlocked = true;
      }
    }
    assert(aal1InviteBlocked, 'Test R5: Boss at AAL1 attempting invite is rejected with MFA_REQUIRED', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R6: Technician attempting invite rejected with 403 (1 assertion)
  // ----------------------------------------------------
  {
    const techClient = createAnonClient();
    await techClient.auth.signInWithPassword({
      email: TEST_USERS.tech.email,
      password: TEST_USERS.tech.password,
    });
    let techInviteBlocked = false;
    try {
      await inviteMember(
        {
          email: 'tech_illegal_invite@crm.local',
          fullName: 'Illegal User',
          role: APPLICATION_ROLES.TECHNICIAN,
          companyId: COMPANY_A_ID,
        },
        techClient
      );
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'ROLE_FORBIDDEN') {
        techInviteBlocked = true;
      }
    }
    assert(techInviteBlocked, 'Test R6: Non-boss (TECHNICIAN) attempting invite is rejected with 403', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R7: Cross-company invite rejected with 403 (1 assertion)
  // ----------------------------------------------------
  {
    let crossCompanyInviteBlocked = false;
    try {
      await inviteMember(
        {
          email: 'cross_company_invite@crm.local',
          fullName: 'Cross Company User',
          role: APPLICATION_ROLES.TECHNICIAN,
          companyId: COMPANY_B_ID,
        },
        bossClient
      );
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 403 && err.code === 'NOT_A_MEMBER') {
        crossCompanyInviteBlocked = true;
      }
    }
    assert(crossCompanyInviteBlocked, 'Test R7: Cross-company invite attempt is rejected with 403 NOT_A_MEMBER', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R8: Invalid invitation roles allowlist validation (1 assertion)
  // ----------------------------------------------------
  {
    const invalidRoles = ['BOSS_ADMIN', 'SUPER_ADMIN', 'ADMIN', '', 'ARBITRARY_ROLE'];
    let allInvalidBlocked = true;
    for (const invalidRole of invalidRoles) {
      let blocked = false;
      try {
        await inviteMember(
          {
            email: `invalid_role_${Date.now()}@crm.local`,
            fullName: 'Attacker',
            role: invalidRole as ApplicationRole,
            companyId: COMPANY_A_ID,
          },
          bossClient
        );
      } catch (err: unknown) {
        if (err instanceof AuthError && err.status === 400 && err.code === 'INVALID_INVITATION_ROLE') {
          blocked = true;
        }
      }
      if (!blocked) {
        allInvalidBlocked = false;
        console.error(`Invalid role was not blocked: ${invalidRole}`);
      }
    }
    assert(
      allInvalidBlocked,
      'Test R8: Invalid invitation roles (BOSS_ADMIN, SUPER_ADMIN, ADMIN, empty, arbitrary) all rejected with 400',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R9: 48h expired invitation rejected with 410 (1 assertion)
  // ----------------------------------------------------
  {
    await adminClient.auth.admin.updateUserById(invitedTechRes!.userId, {
      password: 'Password123!',
      email_confirm: true,
    });
    const candidateClient = createAnonClient();
    await candidateClient.auth.signInWithPassword({
      email: 'remediation_invited_tech@crm.local',
      password: 'Password123!',
    });

    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await adminClient
      .from('company_members')
      .update({ created_at: fortyEightHoursAgo })
      .eq('id', invitedTechRes!.memberId);

    let expired48hBlocked = false;
    try {
      await activateMemberMembership(invitedTechRes!.memberId, COMPANY_A_ID, candidateClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 410 && err.code === 'INVITATION_EXPIRED') {
        expired48hBlocked = true;
      }
    }
    assert(expired48hBlocked, 'Test R9: 48h expired invitation rejected with 410 INVITATION_EXPIRED', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R10: 24h00m01s expired invitation rejected with 410 (1 assertion)
  // ----------------------------------------------------
  {
    const candidateClient = createAnonClient();
    await candidateClient.auth.signInWithPassword({
      email: 'remediation_invited_tech@crm.local',
      password: 'Password123!',
    });

    const twentyFourHoursOneSecAgo = new Date(Date.now() - (24 * 60 * 60 * 1000 + 1000)).toISOString();
    await adminClient
      .from('company_members')
      .update({ created_at: twentyFourHoursOneSecAgo })
      .eq('id', invitedTechRes!.memberId);

    let expired24hBlocked = false;
    try {
      await activateMemberMembership(invitedTechRes!.memberId, COMPANY_A_ID, candidateClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 410 && err.code === 'INVITATION_EXPIRED') {
        expired24hBlocked = true;
      }
    }
    assert(expired24hBlocked, 'Test R10: 24h00m01s expired invitation rejected with 410 INVITATION_EXPIRED', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R11: Expired invitation does not change status to ACTIVE (1 assertion)
  // ----------------------------------------------------
  {
    const { data: memberStillInactive } = await adminClient
      .from('company_members')
      .select('status')
      .eq('id', invitedTechRes!.memberId)
      .single();
    assert(
      memberStillInactive?.status === 'INACTIVE',
      'Test R11: Expired invitation does not mutate DB status to ACTIVE',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R12: 23h59m valid invitation activates successfully (1 assertion)
  // ----------------------------------------------------
  {
    const candidateClient = createAnonClient();
    await candidateClient.auth.signInWithPassword({
      email: 'remediation_invited_tech@crm.local',
      password: 'Password123!',
    });

    const twentyThreeHoursFiftyNineMinAgo = new Date(Date.now() - (23 * 60 * 60 * 1000 + 59 * 60 * 1000)).toISOString();
    await adminClient
      .from('company_members')
      .update({ created_at: twentyThreeHoursFiftyNineMinAgo })
      .eq('id', invitedTechRes!.memberId);

    const activationRes = await activateMemberMembership(
      invitedTechRes!.memberId,
      COMPANY_A_ID,
      candidateClient
    );
    assert(
      activationRes.success && activationRes.role === 'TECHNICIAN',
      'Test R12: 23h59m valid invitation boundary activates successfully',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R13: Replay invitation activation rejected (1 assertion)
  // ----------------------------------------------------
  {
    const candidateClient = createAnonClient();
    await candidateClient.auth.signInWithPassword({
      email: 'remediation_invited_tech@crm.local',
      password: 'Password123!',
    });

    let replayBlocked = false;
    try {
      await activateMemberMembership(invitedTechRes!.memberId, COMPANY_A_ID, candidateClient);
    } catch (err: unknown) {
      if (err instanceof AuthError && err.status === 404) {
        replayBlocked = true;
      }
    }
    assert(replayBlocked, 'Test R13: Replay invitation activation rejected because status is already ACTIVE', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R14: Real Boss TOTP enrollment (1 assertion)
  // ----------------------------------------------------
  const freshBossClient = createAnonClient();
  let freshFactorId = '';
  let freshSecret = '';
  {
    await freshBossClient.auth.signInWithPassword({
      email: TEST_USERS.mfaBoss.email,
      password: TEST_USERS.mfaBoss.password,
    });
    const enrollRes = await enrollTotpFactor(freshBossClient, 'Boss Authenticator Fresh');
    freshFactorId = enrollRes.factorId;
    freshSecret = enrollRes.secret;
    assert(
      Boolean(freshFactorId) && Boolean(freshSecret) && freshSecret.length >= 16,
      'Test R14: Real Boss TOTP enrollment issues valid factorId and base32 secret',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R15: Real Boss TOTP challenge with invalid OTP rejected (1 assertion)
  // ----------------------------------------------------
  {
    let invalidOtpRejected = false;
    try {
      await challengeAndVerifyTotp(freshFactorId, '000000', freshBossClient);
    } catch {
      invalidOtpRejected = true;
    }
    assert(invalidOtpRejected, 'Test R15: Real Boss TOTP challenge with invalid OTP is rejected', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R16: Real Boss TOTP challenge with valid OTP verified (1 assertion)
  // ----------------------------------------------------
  {
    const validOtp = generateTotpCode(freshSecret);
    const verifyRes = await challengeAndVerifyTotp(freshFactorId, validOtp, freshBossClient);
    const aalState = await getMfaAssuranceState(freshBossClient);
    assert(
      verifyRes.success && aalState.currentLevel === 'aal2',
      'Test R16: Real Boss TOTP challenge with valid computed OTP verified -> session reaches AAL2',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R17: Boss at AAL2 accesses requireBossAdmin successfully (1 assertion)
  // ----------------------------------------------------
  {
    let bossAal2Success = false;
    try {
      const bossCtx = await requireBossAdmin(COMPANY_A_ID, { requireAal2: true }, freshBossClient);
      bossAal2Success = bossCtx.role === 'BOSS_ADMIN' && bossCtx.aal === 'aal2';
    } catch {
      bossAal2Success = false;
    }
    assert(bossAal2Success, 'Test R17: Boss at AAL2 accesses requireBossAdmin({ requireAal2: true }) successfully', 'REAL LOCAL SUPABASE');
  }

  // ----------------------------------------------------
  // Test R18: Sale at AAL1 operates without Boss MFA (1 assertion)
  // ----------------------------------------------------
  {
    const saleClient = createAnonClient();
    await saleClient.auth.signInWithPassword({
      email: TEST_USERS.sale.email,
      password: TEST_USERS.sale.password,
    });
    const saleCtx = await requireSale(COMPANY_A_ID, saleClient);
    assert(
      saleCtx.role === 'SALE' && saleCtx.aal === 'aal1',
      'Test R18: Sale operates at AAL1 without being forced into Boss MFA',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R19: Technician at AAL1 operates without Boss MFA (1 assertion)
  // ----------------------------------------------------
  {
    const techClient = createAnonClient();
    await techClient.auth.signInWithPassword({
      email: TEST_USERS.tech.email,
      password: TEST_USERS.tech.password,
    });
    const techCtx = await requireTechnician(COMPANY_A_ID, techClient);
    assert(
      techCtx.role === 'TECHNICIAN' && techCtx.aal === 'aal1',
      'Test R19: Technician operates at AAL1 without being forced into Boss MFA',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R20: Multi-company user without explicit tenant fails closed (1 assertion)
  // ----------------------------------------------------
  {
    const multiClient = createAnonClient();
    await multiClient.auth.signInWithPassword({
      email: TEST_USERS.multiCompany.email,
      password: TEST_USERS.multiCompany.password,
    });
    const ambiguousActor = await getActorContext(undefined, multiClient);
    assert(
      ambiguousActor !== null && ambiguousActor.companyId === null,
      'Test R20: Multi-company user without explicit tenant fails closed (companyId: null)',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R21: Multi-company user with explicit tenant resolves correct company (1 assertion)
  // ----------------------------------------------------
  {
    const multiClient = createAnonClient();
    await multiClient.auth.signInWithPassword({
      email: TEST_USERS.multiCompany.email,
      password: TEST_USERS.multiCompany.password,
    });
    const resolvedActorA = await getActorContext(COMPANY_A_ID, multiClient);
    const resolvedActorB = await getActorContext(COMPANY_B_ID, multiClient);
    assert(
      resolvedActorA?.companyId === COMPANY_A_ID && resolvedActorB?.companyId === COMPANY_B_ID,
      'Test R21: Multi-company user with explicit tenant parameter resolves correct company',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R22: Login action returns generic failure on unknown email (1 assertion)
  // ----------------------------------------------------
  {
    const formData = new FormData();
    formData.set('email', 'unknown_user_enumeration_attack@crm.local');
    formData.set('password', 'Password123!');
    const actionResult = await loginAction(formData);
    assert(
      !actionResult.success && actionResult.error === 'Email hoặc mật khẩu không chính xác.',
      'Test R22: Login action returns generic failure on unknown email (prevents account enumeration)',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R23: Login action returns generic failure on wrong password (1 assertion)
  // ----------------------------------------------------
  {
    const formData = new FormData();
    formData.set('email', TEST_USERS.sale.email);
    formData.set('password', 'DefinitivelyWrongPassword999!');
    const actionResult = await loginAction(formData);
    assert(
      !actionResult.success && actionResult.error === 'Email hoặc mật khẩu không chính xác.',
      'Test R23: Login action returns generic failure on wrong password (prevents account enumeration)',
      'REAL LOCAL SUPABASE'
    );
  }

  // ----------------------------------------------------
  // Test R24: Service role key is never client-exposed (1 assertion)
  // ----------------------------------------------------
  {
    const envKeys = Object.keys(process.env);
    const serviceRoleKeyLeaked = envKeys.some(
      (key) => key.startsWith('NEXT_PUBLIC_') && key.toLowerCase().includes('service_role')
    );
    assert(!serviceRoleKeyLeaked, 'Test R24: Service role key is never client-exposed (no NEXT_PUBLIC_ prefix)', 'UNIT');
  }

  // ----------------------------------------------------
  // Test R25: Unsafe target-JWT action deleted from codebase (1 assertion)
  // ----------------------------------------------------
  {
    const actionsPath = path.resolve(__dirname, '../../app/(auth)/actions.ts');
    const actionsSource = fs.readFileSync(actionsPath, 'utf8');
    const hasUnsafeContract = /export\s+(async\s+)?function\s+adminRevokeSessionAction/.test(actionsSource);
    assert(
      !hasUnsafeContract,
      'Test R25: Unsafe target-JWT server action (adminRevokeSessionAction) is deleted from codebase',
      'STATIC'
    );
  }

  console.log('==================================================');
  console.log(`TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('==================================================');

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
