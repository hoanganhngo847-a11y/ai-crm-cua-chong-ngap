import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authorizeZaloWorker } from '@/features/omnichannel/zalo/accounts/worker-auth';
import { decryptZaloCredentials } from '@/features/omnichannel/zalo/accounts/credentials';
import { ACCOUNT_UUID } from '@/features/omnichannel/zalo/accounts/scope';

export const runtime = 'nodejs';
const headers = { 'cache-control': 'no-store' };
export async function GET(request: NextRequest) {
  const companyId = authorizeZaloWorker(request);
  if (!companyId) return NextResponse.json({ success: false }, { status: 401, headers });
  try {
    const { data, error } = await createAdminClient().rpc('get_zalo_runtime_accounts', { p_company_id: companyId });
    if (error) throw new Error('READ_FAILED');
    const accounts = (data || []).map((account: { id: string; label: string; revision: number; encrypted_credentials: Record<string, unknown> }) => ({
      id: account.id, label: account.label, revision: account.revision,
      ...decryptZaloCredentials(companyId, account.id, account.encrypted_credentials),
    }));
    return NextResponse.json({ success: true, companyId, accounts }, { headers });
  } catch { return NextResponse.json({ success: false, error: 'ACCOUNT_CONFIG_UNAVAILABLE' }, { status: 503, headers }); }
}
const ERRORS = new Set(['LOGIN_FAILED','LISTENER_DISCONNECTED','PROCESS_EXITED','DUPLICATE_ZALO_ACCOUNT','ZALO_ACCOUNT_IDENTITY_CHANGED','ZALO_LEGACY_NOT_READY']);
export async function POST(request: NextRequest) {
  const companyId = authorizeZaloWorker(request);
  if (!companyId) return NextResponse.json({ success: false }, { status: 401, headers });
  try {
    const body = await request.json();
    const accountId = body.accountId === null ? null : String(body.accountId || '');
    if (accountId !== null && !ACCOUNT_UUID.test(accountId)) return NextResponse.json({ success: false }, { status: 400, headers });
    const providerUid = typeof body.providerUid === 'string' && /^[0-9]{5,40}$/.test(body.providerUid) ? body.providerUid : null;
    const status = ['CONNECTING','CONNECTED','ERROR'].includes(body.status) ? body.status : 'ERROR';
    const revision = Number.isSafeInteger(body.revision) ? body.revision : 0;
    const { data, error } = await createAdminClient().rpc('report_zalo_account_runtime', {
      p_company_id: companyId, p_id: accountId, p_revision: revision, p_status: status, p_provider_uid: providerUid,
      p_error_code: ERRORS.has(body.errorCode) ? body.errorCode : null,
    });
    if (error) {
      const code = [...ERRORS].find((value) => error.message.includes(value)) || 'ACCOUNT_VERIFICATION_FAILED';
      return NextResponse.json({ success: false, error: code }, { status: 409, headers });
    }
    return NextResponse.json({ success: data === true }, { status: data === true ? 200 : 409, headers });
  } catch { return NextResponse.json({ success: false, error: 'ACCOUNT_STATE_UNAVAILABLE' }, { status: 503, headers }); }
}
