import { NextResponse } from 'next/server';

/** Tenant-less webhook URLs are deliberately disabled. */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Integration route required' }, { status: 404 });
}
