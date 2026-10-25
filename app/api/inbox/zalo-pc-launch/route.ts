import { NextRequest, NextResponse } from 'next/server';
import { resolveZaloPcHandoff } from '@/features/inbox/services/zalo-pc-handoff';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const customerId = new URL(request.url).searchParams.get('customer_id')?.trim() || '';
    const resolution = await resolveZaloPcHandoff(customerId);
    if (!resolution.ok) {
      return NextResponse.json(
        { success: false, error: resolution.error },
        { status: resolution.status, headers: { 'cache-control': 'no-store' } }
      );
    }

    const location = `zalo://conversation?phone=${encodeURIComponent(resolution.phone)}`;
    return new NextResponse(null, {
      status: 307,
      headers: {
        location,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    console.error(
      '[Inbox Zalo PC launch] handoff failed:',
      error instanceof Error ? error.message : 'unknown'
    );
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR' },
      { status: 500, headers: { 'cache-control': 'no-store' } }
    );
  }
}
