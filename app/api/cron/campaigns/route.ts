import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { processCampaignBatch } from "../../../../features/campaigns/worker";
import { z } from "zod";
export const runtime = "nodejs";
export const maxDuration = 60;
// No scheduler is installed by this feature. Explicit, tenant-targeted calls only.
export async function POST(request: NextRequest) {
  const expected = process.env.CAMPAIGN_CRON_SECRET;
  const supplied = request.headers.get("authorization") || "";
  if (
    !expected ||
    expected.length < 32 ||
    Buffer.byteLength(supplied) !== Buffer.byteLength(`Bearer ${expected}`) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${expected}`))
  )
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const params = [...request.nextUrl.searchParams];
  const schema = z
    .object({
      companyId: z.string().uuid(),
      channel: z.enum(["FACEBOOK", "ZALO_OA"]),
      limit: z.coerce.number().int().min(1).max(3).default(3),
    })
    .strict();
  const parsed = schema.safeParse(Object.fromEntries(params));
  if (new Set(params.map(([k]) => k)).size !== params.length || !parsed.success)
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  try {
    return NextResponse.json(await processCampaignBatch(parsed.data));
  } catch {
    return NextResponse.json(
      { error: "CAMPAIGN_WORKER_FAILED" },
      { status: 503 },
    );
  }
}
