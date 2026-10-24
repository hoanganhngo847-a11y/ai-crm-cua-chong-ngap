import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../../lib/supabase/admin";
import { z } from "zod";
import {
  campaignAdapters,
  type CampaignAdapter,
  type DeliveryJob,
  type DeliveryResult,
} from "./adapters";
import { channelSchema } from "./contracts";

export async function processCampaignBatch(
  input: { companyId: string; channel: string; limit?: number },
  dependencies: {
    db?: SupabaseClient;
    adapter?: CampaignAdapter;
  } = {},
) {
  const parsed = z
    .object({
      companyId: z.string().uuid(),
      channel: channelSchema,
      limit: z.number().int().min(1).max(10).default(5),
    })
    .strict()
    .parse(input);
  if (
    process.env.BULK_MESSAGING_ENABLED !== "true" ||
    process.env[
      parsed.channel === "FACEBOOK"
        ? "FACEBOOK_CAMPAIGNS_ENABLED"
        : "ZALO_OA_CAMPAIGNS_ENABLED"
    ] !== "true"
  )
    return { status: "DISABLED", processed: 0 };
  const adapter = dependencies.adapter ?? campaignAdapters[parsed.channel];
  if (!adapter.verified) return { status: "TRANSPORT_DISABLED", processed: 0 };
  const db = dependencies.db ?? createAdminClient();
  let processed = 0;
  for (let n = 0; n < parsed.limit; n++) {
    const claim = await db.rpc("campaign_claim", {
      p_company: parsed.companyId,
      p_channel: parsed.channel,
    });
    if (claim.error) throw new Error("CAMPAIGN_CLAIM_FAILED");
    if (!claim.data) break;
    const row = claim.data as Pick<DeliveryJob, "id" | "lock_token">;
    const args = {
      p_company: parsed.companyId,
      p_recipient: row.id,
      p_token: row.lock_token,
    };
    const begin = await db.rpc("campaign_begin", args);
    if (begin.error) throw new Error("CAMPAIGN_REVALIDATION_FAILED");
    if (!begin.data) continue;
    let result: DeliveryResult;
    // Ambiguous timeouts/throws must never become retryable. A certified adapter must bound
    // network duration below the lease and report TRANSIENT only for proven non-acceptance.
    try {
      result = await adapter.send(begin.data as DeliveryJob);
    } catch {
      result = { status: "UNCERTAIN", code: "ADAPTER_OUTCOME_UNKNOWN" };
    }
    const finished = await db.rpc("campaign_finish", {
      ...args,
      p_status: result.status,
      p_message_id: result.status === "SENT" ? result.messageId : null,
      p_code: result.status === "SENT" ? null : result.code,
    });
    if (finished.error || finished.data !== true)
      throw new Error("CAMPAIGN_RESULT_UNPERSISTED");
    processed++;
  }
  return { status: "PROCESSED", processed };
}
