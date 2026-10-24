import "server-only";
import { z } from "zod";
import { createAdminClient } from "../../lib/supabase/admin";
import { bindingsForCompany } from "../omnichannel/facebook/binding";
import { recordingActor } from "../zalo-recordings/access";
import { sanitizePhoneInText } from "../crm/utils/phone-sanitizer";
import { campaignAdapters, channelEnabled } from "./adapters";
import {
  createSchema,
  confirmSchema,
  templateSchema,
  templateVariables,
  type CampaignData,
} from "./contracts";

// Browser DTOs never contain tokens, provider routing identities or raw private contacts.
export function safeCampaignDto(value: unknown): unknown {
  if (typeof value === "string") return sanitizePhoneInText(value);
  if (Array.isArray(value)) return value.map(safeCampaignDto);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        [
          "id",
          "customer_id",
          "sender_account_id",
          "created_by",
          "actor_user_id",
          "created_at",
          "scheduled_at",
          "started_at",
          "finished_at",
          "sent_at",
          "delivered_at",
          "read_at",
          "provider_message_id",
        ].includes(k)
          ? v
          : safeCampaignDto(v),
      ]),
    );
  return value;
}
export async function campaignRead(
  input: {
    id?: string;
    customer_ids?: string[];
    page?: number;
    status?: string;
  } = {},
) {
  const actor = await recordingActor();
  const data = z
    .object({
      id: z.string().uuid().optional(),
      customer_ids: z.array(z.string().uuid()).max(500).optional(),
      page: z.number().int().min(1).max(10000).optional(),
      status: z
        .enum(["ALL", "RUNNING", "SCHEDULED", "COMPLETED", "FAILED"])
        .optional(),
    })
    .strict()
    .parse(input);
  if (process.env.BULK_MESSAGING_ENABLED !== "true")
    return {
      actor,
      data: null,
      readiness: { FACEBOOK: false, ZALO_OA: false },
    };
  let pages: { id: string; name: string; connected: boolean }[] = [];
  try {
    pages = bindingsForCompany(actor.companyId).map((b) => ({
      id: b.page,
      name: b.name || "Facebook Page",
      connected: Boolean(process.env[b.tokenEnv]),
    }));
  } catch {
    /* Missing/invalid bindings fail closed. */
  }
  const sync = await createAdminClient().rpc("campaign_sync_senders", {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_pages: pages,
  });
  if (sync.error) throw new Error("CAMPAIGN_SENDERS_UNAVAILABLE");
  const result = await createAdminClient().rpc("campaign_read", {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_input: data,
  });
  if (result.error || !result.data) throw new Error("CAMPAIGN_UNAVAILABLE");
  return {
    actor,
    data: safeCampaignDto(result.data) as CampaignData,
    readiness: {
      FACEBOOK: channelEnabled("FACEBOOK"),
      ZALO_OA: channelEnabled("ZALO_OA"),
    },
  };
}
export async function campaignCommand(command: string, input: unknown) {
  const actor = await recordingActor();
  if (process.env.BULK_MESSAGING_ENABLED !== "true")
    throw new Error("MODULE_DISABLED");
  let parsed: unknown;
  switch (command) {
    case "create":
      parsed = createSchema.parse(input);
      break;
    case "template": {
      const t = templateSchema.parse(input);
      templateVariables(t.content);
      parsed = t;
      break;
    }
    case "confirm": {
      parsed = confirmSchema.parse(input);
      const { data } = await campaignRead({
        id: (parsed as { id: string }).id,
      });
      if (
        !data?.campaign ||
        !channelEnabled(data.campaign.channel) ||
        !campaignAdapters[data.campaign.channel].verified
      )
        throw new Error("TRANSPORT_DISABLED");
      break;
    }
    case "suppress":
      parsed = z
        .object({
          customer_id: z.string().uuid(),
          channel: z.enum(["FACEBOOK", "ZALO_OA"]),
          status: z.enum(["DO_NOT_MESSAGE", "UNSUBSCRIBED", "BLOCKED"]),
        })
        .strict()
        .parse(input);
      break;
    case "validate":
    case "pause":
    case "resume":
    case "cancel":
      parsed = z.object({ id: z.string().uuid() }).strict().parse(input);
      break;
    default:
      throw new Error("INVALID_COMMAND");
  }
  const result = await createAdminClient().rpc("campaign_command", {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_command: command,
    p_input: parsed,
  });
  if (result.error) throw new Error("CAMPAIGN_COMMAND_REJECTED");
  return result.data as { id: string };
}
