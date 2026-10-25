import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { APPLICATION_ROLES } from '@/shared/constants/roles';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZALO_UID_REGEX = /^[0-9]{5,40}$/;

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const customerId = new URL(request.url).searchParams.get('customer_id')?.trim() || '';
    if (!UUID_REGEX.test(customerId)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_CUSTOMER_ID' },
        { status: 400 }
      );
    }

    const supabase = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 });
    }

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
      return NextResponse.json({ success: false, error: 'FORBIDDEN' }, { status: 403 });
    }

    const admin = createAdminClient();
    const { data: customer, error: customerError } = await admin
      .from('customers')
      .select('id')
      .eq('company_id', member.company_id)
      .eq('id', customerId)
      .maybeSingle();
    if (customerError) throw customerError;
    if (!customer) {
      return NextResponse.json({ success: false, error: 'NOT_FOUND' }, { status: 404 });
    }

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
      return NextResponse.json(
        { success: false, error: 'ZALO_PERSONAL_IDENTITY_NOT_FOUND' },
        { status: 404 }
      );
    }
    if (personal.length !== 1) {
      return NextResponse.json(
        { success: false, error: 'ZALO_PERSONAL_IDENTITY_CONFLICT' },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        uid: personal[0].external_id,
      },
    });
  } catch (error) {
    console.error(
      '[Inbox Zalo call target] lookup failed:',
      error instanceof Error ? error.message : 'unknown'
    );
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
