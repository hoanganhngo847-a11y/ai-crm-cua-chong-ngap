import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getActorContext } from '@/lib/auth/context';
import { syncZaloGroup } from '@/features/omnichannel/zalo/group-sync';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const actor = await getActorContext();
    if (!actor) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 });
    if (actor.profileStatus !== 'ACTIVE' || actor.membershipStatus !== 'ACTIVE' || !actor.companyId ||
        (actor.role !== 'SALE' && actor.role !== 'BOSS_ADMIN')) {
      return NextResponse.json({ success: false, error: 'FORBIDDEN' }, { status: 403 });
    }
    if (actor.role === 'BOSS_ADMIN' && actor.aal !== 'aal2') {
      return NextResponse.json({ success: false, error: 'MFA_REQUIRED' }, { status: 403 });
    }
    const body = await request.json().catch(() => null);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
      return NextResponse.json({ success: false, error: 'INVALID_CONVERSATION_ID' }, { status: 400 });
    }
    const result = await syncZaloGroup({
      client: createAdminClient(), companyId: actor.companyId, conversationId,
      workerUrl: (process.env.ZALO_ZCAJS_WORKER_URL || '').trim(),
      workerSecret: process.env.ZALO_ZCAJS_WORKER_SECRET || '',
    });
    return NextResponse.json(result, { status: 'status' in result ? result.status : 200 });
  } catch (error) {
    console.error('[group-sync] failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ success: false, error: 'GROUP_SYNC_FAILED' }, { status: 500 });
  }
}
