import { NextRequest, NextResponse } from 'next/server';
import { resolveZaloPcHandoff } from '@/features/inbox/services/zalo-pc-handoff';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const customerId = new URL(request.url).searchParams.get('customer_id')?.trim() || '';
    const resolution = await resolveZaloPcHandoff(customerId);
    if (!resolution.ok) {
      return NextResponse.json(
        { success: false, error: resolution.error, nativeReady: false },
        { status: resolution.status }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        nativeReady: true,
        launchUrl: `/api/inbox/zalo-pc-launch?customer_id=${encodeURIComponent(customerId)}`,
      },
    });
  } catch (error) {
    console.error(
      '[Inbox Zalo PC target] lookup failed:',
      error instanceof Error ? error.message : 'unknown'
    );
    return NextResponse.json(
      { success: false, error: 'INTERNAL_ERROR', nativeReady: false },
      { status: 500 }
    );
  }
}
