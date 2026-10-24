import "server-only";
import { z } from "zod";
import { createAdminClient } from "../../lib/supabase/admin";
import { bindingsForCompany } from "../omnichannel/facebook/binding";
import {
  ensureZcaJsRoutingConfig,
  getZaloTransportMode,
} from "../omnichannel/zalo/zcajs-client";
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

async function campaignReplyCount(
  companyId: string,
  data: CampaignData,
): Promise<number | null> {
  const campaign = data.campaign;
  if (!campaign) return null;

  const sentRecipients = data.recipients.filter(
    (recipient) => recipient.sent_at && recipient.customer_id,
  );
  if (sentRecipients.length === 0) return 0;

  const sentAtByCustomer = new Map<string, number>();
  for (const recipient of sentRecipients) {
    const sentAt = recipient.sent_at
      ? new Date(recipient.sent_at).getTime()
      : Number.NaN;
    if (!Number.isFinite(sentAt)) continue;
    const current = sentAtByCustomer.get(recipient.customer_id);
    if (current === undefined || sentAt < current)
      sentAtByCustomer.set(recipient.customer_id, sentAt);
  }
  if (sentAtByCustomer.size === 0) return 0;

  const earliestSentAt = Math.min(...sentAtByCustomer.values());
  const interactionChannel =
    campaign.channel === "ZALO_OA" || campaign.channel === "ZALO_PERSONAL"
      ? "ZALO"
      : "FACEBOOK";
  const result = await createAdminClient()
    .from("interactions")
    .select("customer_id,created_at")
    .eq("company_id", companyId)
    .eq("type", "MESSAGE")
    .eq("direction", "INBOUND")
    .eq("channel", interactionChannel)
    .in("customer_id", [...sentAtByCustomer.keys()])
    .gte("created_at", new Date(earliestSentAt).toISOString());

  if (result.error) return null;

  const replied = new Set<string>();
  for (const row of result.data || []) {
    if (!row.customer_id || !row.created_at) continue;
    const sentAt = sentAtByCustomer.get(row.customer_id);
    if (sentAt === undefined) continue;
    const inboundAt = new Date(row.created_at).getTime();
    if (Number.isFinite(inboundAt) && inboundAt >= sentAt)
      replied.add(row.customer_id);
  }
  return replied.size;
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

  if (getZaloTransportMode() === "ZCAJS") {
    try {
      await ensureZcaJsRoutingConfig(createAdminClient(), actor.companyId);
    } catch {
      /* Personal Zalo sender remains unavailable until routing is healthy. */
    }
  }

  const db = createAdminClient();
  const sync = await db.rpc("campaign_sync_senders", {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_pages: pages,
  });
  if (sync.error) throw new Error("CAMPAIGN_SENDERS_UNAVAILABLE");
  const result = await db.rpc("campaign_read", {
    p_company: actor.companyId,
    p_actor: actor.userId,
    p_input: data,
  });
  if (result.error || !result.data) throw new Error("CAMPAIGN_UNAVAILABLE");

  const dto = safeCampaignDto(result.data) as CampaignData;
  if (dto.campaign) {
    const repliedCount = await campaignReplyCount(actor.companyId, dto);
    (
      dto.campaign as typeof dto.campaign & {
        replied_count?: number | null;
      }
    ).replied_count = repliedCount;
  }

  const deliveryEnabled = process.env.BULK_MESSAGING_ENABLED === "true";
  return {
    actor,
    data: dto,
    readiness: {
      FACEBOOK: deliveryEnabled && channelEnabled("FACEBOOK"),
      ZALO_OA: deliveryEnabled && channelEnabled("ZALO_OA"),
      ZALO_PERSONAL: channelEnabled("ZALO_PERSONAL"),
    },
  };
}

export async function campaignCommand(command: string, input: unknown) {
  const actor = await recordingActor();
  const deliveryEnabled = process.env.BULK_MESSAGING_ENABLED === "true";
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
      if (!data?.campaign) throw new Error("CAMPAIGN_UNAVAILABLE");
      if (data.campaign.channel === "ZALO_PERSONAL") {
        if (
          !channelEnabled("ZALO_PERSONAL") ||
          !campaignAdapters.ZALO_PERSONAL.verified
        )
          throw new Error("TRANSPORT_DISABLED");
      } else if (
        !deliveryEnabled ||
        !data.enabled ||
        !channelEnabled(data.campaign.channel) ||
        !campaignAdapters[data.campaign.channel].verified
      ) {
        throw new Error("TRANSPORT_DISABLED");
      }
      break;
    }
    case "suppress":
      parsed = z
        .object({
          customer_id: z.string().uuid(),
          channel: z.enum(["FACEBOOK", "ZALO_OA", "ZALO_PERSONAL"]),
          status: z.enum(["DO_NOT_MESSAGE", "UNSUBSCRIBED", "BLOCKED"]),
        })
        .strict()
        .parse(input);
      break;
    case "unsuppress":
      parsed = z
        .object({
          customer_id: z.string().uuid(),
          channel: z.enum(["FACEBOOK", "ZALO_OA", "ZALO_PERSONAL"]),
          reason: z.string().trim().min(3).max(500).optional(),
        })
        .strict()
        .parse(input);
      break;
    case "validate":
      parsed = z.object({ id: z.string().uuid() }).strict().parse(input);
      break;
    case "pause":
    case "resume":
    case "cancel": {
      parsed = z.object({ id: z.string().uuid() }).strict().parse(input);
      const { data } = await campaignRead({ id: (parsed as { id: string }).id });
      const personal = data.campaign?.channel === "ZALO_PERSONAL";
      if (!personal && !deliveryEnabled) throw new Error("TRANSPORT_DISABLED");
      if (personal && !channelEnabled("ZALO_PERSONAL") && command !== "cancel")
        throw new Error("TRANSPORT_DISABLED");
      break;
    }
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

export async function verifyProviderIdentity(input: {
  companyId: string;
  channel: "FACEBOOK" | "ZALO_OA";
  senderAccountExternalId: string;
  externalCustomerId: string;
  evidence?: Record<string, unknown>;
}) {
  const schema = z
    .object({
      companyId: z.string().uuid(),
      channel: z.enum(["FACEBOOK", "ZALO_OA"]),
      senderAccountExternalId: z.string().regex(/^[0-9]+$/),
      externalCustomerId: z.string().regex(/^[0-9]+$/),
      evidence: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();
  const parsed = schema.parse(input);
  const result = await createAdminClient().rpc("campaign_verify_identity", {
    p_company: parsed.companyId,
    p_channel: parsed.channel,
    p_sender_id: parsed.senderAccountExternalId,
    p_recipient_id: parsed.externalCustomerId,
    p_evidence: parsed.evidence || {},
  });
  if (result.error) throw new Error(result.error.message);
  return result.data as {
    ok: boolean;
    identity_id: string;
    customer_id: string;
  };
}
