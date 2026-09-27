import { NextResponse } from 'next/server';

/** Tenant-less webhook URLs are deliberately disabled. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Integration route required' }, { status: 404 });
}

export const POST = GET;
