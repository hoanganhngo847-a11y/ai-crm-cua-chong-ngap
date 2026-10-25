import 'server-only';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { APPLICATION_ROLES } from '@/shared/constants/roles';
import { resolveZcaJsPhone } from '@/features/omnichannel/zalo/zcajs-phone';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZALO_UID_REGEX = /^[0-9]{5,40}$/;

type Failure = { ok: false; status: number; error: string };
type Success = { ok: true; phone: string };
export type ZaloPcHandoffResolution = Failure | Success;

export async function resolveZaloPcHandoff(customerId: string): Promise<ZaloPcHandoffResolution> {
  if (!UUID_REGEX.test(customerId)) return { ok: false, status: 400, error: 'INVALID_CUSTOMER_ID' };

  const supabase = await createServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, status: 401, error: 'UNAUTHORIZED' };

  let member: { company_id: string; role: string; status: string } | null = null;
  const { data: companyMember } = await supabase
    .from('company_members')
    .select('company_id, role, status')
    .eq('user_id', user.id)
    .eq('status', 'ACTIVE')
    .maybeSingle();
  if (companyMember) {
    member = companyMember;
  } else {
    const { data: legacyMember } = await supabase
      .from('members')
      .select('company_id, role, status')
      .eq('user_id', user.id)
      .eq('status', 'ACTIVE')
      .maybeSingle();
    if (legacyMember) member = legacyMember;
  }

  if (
    !member ||
    member.status !== 'ACTIVE' ||
    (member.role !== APPLICATION_ROLES.SALE && member.role !== APPLICATION_ROLES.BOSS_ADMIN)
  ) {
    return { ok: false, status: 403, error: 'FORBIDDEN' };
  }

  const admin = createAdminClient();
  const { data: customer, error: customerError } = await admin
    .from('customers')
    .select('id')
    .eq('company_id', member.company_id)
    .eq('id', customerId)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customer) return { ok: false, status: 404, error: 'NOT_FOUND' };

  const { data: identities, error: identityError } = await admin
    .from('identities')
    .select('external_id, metadata')
    .eq('company_id', member.company_id)
    .eq('customer_id', customerId)
    .eq('channel', 'ZALO');
  if (identityError) throw identityError;

  const personal = (identities || []).filter((row) => {
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const source = typeof metadata.source === 'string' ? metadata.source.toUpperCase() : '';
    const provider = typeof metadata.provider === 'string' ? metadata.provider.toLowerCase() : '';
    return ZALO_UID_REGEX.test(row.external_id || '') && (source === 'ZCAJS' || provider === 'zcajs');
  });

  if (personal.length === 0) {
    return { ok: false, status: 404, error: 'ZALO_PERSONAL_IDENTITY_NOT_FOUND' };
  }
  if (personal.length !== 1) {
    return { ok: false, status: 409, error: 'ZALO_PERSONAL_IDENTITY_CONFLICT' };
  }

  const phone = await resolveZcaJsPhone(member.company_id, personal[0].external_id);
  if (!phone) return { ok: false, status: 409, error: 'ZALO_PHONE_NOT_AVAILABLE' };
  return { ok: true, phone };
}
