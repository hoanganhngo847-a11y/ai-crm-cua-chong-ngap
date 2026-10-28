import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getZaloTransportMode } from '@/features/omnichannel/zalo/zcajs-client';

export const runtime = 'nodejs';

function secureCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function POST(request: NextRequest) {
  try {
    if (getZaloTransportMode() !== 'ZCAJS') {
      return NextResponse.json({ success: false, error: 'ZCAJS_TRANSPORT_DISABLED' }, { status: 503 });
    }

    const configuredSecret = process.env.ZALO_ZCAJS_WORKER_SECRET || '';
    const providedSecret =
      request.headers.get('x-worker-secret') ||
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
      '';
    if (!configuredSecret || !providedSecret || !secureCompare(providedSecret, configuredSecret)) {
      return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 });
    }

    const configuredCompanyId = (process.env.ZALO_ZCAJS_COMPANY_ID || '').trim();
    const body = await request.json().catch(() => null) as
      | { companyId?: unknown; contacts?: unknown }
      | null;
    if (!body || body.companyId !== configuredCompanyId || !Array.isArray(body.contacts)) {
      return NextResponse.json({ success: false, error: 'INVALID_PAYLOAD' }, { status: 400 });
    }
    if (body.contacts.length > 5000) {
      return NextResponse.json({ success: false, error: 'CONTACT_BATCH_TOO_LARGE' }, { status: 413 });
    }

    const contacts = body.contacts
      .map((value) => {
        if (!value || typeof value !== 'object') return null;
        const row = value as Record<string, unknown>;
        const externalUserId = typeof row.externalUserId === 'string' ? row.externalUserId.trim() : '';
        const displayName = typeof row.displayName === 'string'
          ? row.displayName.replace(/\s+/g, ' ').trim().slice(0, 160)
          : '';
        if (!/^[0-9]{5,40}$/.test(externalUserId)) return null;
        return { externalUserId, ...(displayName ? { displayName } : {}) };
      })
      .filter(Boolean);

    const { data, error } = await createAdminClient().rpc('sync_zalo_personal_contacts', {
      p_company: configuredCompanyId,
      p_contacts: contacts,
    });
    if (error) {
      console.error('[ZCAJS contacts] sync failed:', error.message);
      return NextResponse.json({ success: false, error: 'CONTACT_SYNC_FAILED' }, { status: 500 });
    }

    const result = (data || {}) as Record<string, unknown>;

    const { data: repairData, error: repairError } = await createAdminClient().rpc(
      'repair_zalo_personal_display_names',
      { p_company: configuredCompanyId }
    );
    if (repairError) {
      // Directory sync must still succeed even if the display-name repair projection fails.
      console.warn('[ZCAJS contacts] display-name repair failed:', repairError.message);
    }
    const repaired = (repairData || {}) as Record<string, unknown>;

    return NextResponse.json({
      success: true,
      seen: Number(result.seen || 0),
      autoLinked: Number(result.auto_linked || 0),
      displayNamesRepaired: Number(repaired.customers || 0),
    });
  } catch (error) {
    console.error('[ZCAJS contacts] unexpected failure:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ success: false, error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
