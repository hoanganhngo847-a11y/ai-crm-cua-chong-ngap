import "server-only";
import type { Channel } from "./contracts";
import { getZaloTransportClient, getZaloTransportMode } from "../omnichannel/zalo/zcajs-client";

export type DeliveryJob = {
  id: string;
  company_id: string;
  campaign_id: string;
  lock_token: string;
  channel: Channel;
  sender_external_id: string;
  recipient_external_id: string;
  personalized_payload: { text: string };
  template_snapshot: Record<string, unknown>;
};
export type DeliveryResult =
  | { status: "SENT"; messageId: string }
  | { status: "TRANSIENT" | "PERMANENT" | "UNCERTAIN"; code: string };
export interface CampaignAdapter {
  verified: boolean;
  send(job: DeliveryJob): Promise<DeliveryResult>;
}

export const campaignAdapters: Record<Channel, CampaignAdapter> = {
  FACEBOOK: {
    verified: false,
    async send() {
      return { status: "PERMANENT", code: "TRANSPORT_DISABLED" };
    },
  },
  ZALO_OA: {
    verified: false,
    async send() {
      return { status: "PERMANENT", code: "TRANSPORT_DISABLED" };
    },
  },
  ZALO_PERSONAL: {
    verified: true,
    async send(job) {
      try {
        const client = await getZaloTransportClient(
          job.company_id,
          job.sender_external_id,
        );
        const result = await client.sendTextMessageWithOutcome(
          job.recipient_external_id,
          job.personalized_payload.text,
        );
        if (result.outcome === "ACCEPTED") {
          const messageId = String(result.providerMsgId || "").trim();
          return messageId
            ? { status: "SENT", messageId }
            : { status: "UNCERTAIN", code: "MISSING_PROVIDER_MSG_ID" };
        }
        if (result.outcome === "REJECTED") {
          return {
            status: "PERMANENT",
            code: result.errorCode || "ZCAJS_REJECTED",
          };
        }
        return {
          status: "UNCERTAIN",
          code: result.errorCode || "ZCAJS_OUTCOME_UNKNOWN",
        };
      } catch {
        return { status: "UNCERTAIN", code: "ZCAJS_CLIENT_UNAVAILABLE" };
      }
    },
  },
};

export function channelEnabled(channel: Channel) {
  if (channel === "ZALO_PERSONAL") {
    return (
      process.env.ZALO_PERSONAL_CAMPAIGNS_ENABLED === "true" &&
      getZaloTransportMode() === "ZCAJS" &&
      campaignAdapters.ZALO_PERSONAL.verified
    );
  }

  return (
    process.env.BULK_MESSAGING_ENABLED === "true" &&
    process.env[
      channel === "FACEBOOK"
        ? "FACEBOOK_CAMPAIGNS_ENABLED"
        : "ZALO_OA_CAMPAIGNS_ENABLED"
    ] === "true" &&
    campaignAdapters[channel].verified
  );
}
