import "server-only";
import type { Channel } from "./contracts";

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
  /** True only after policy, approval, rate-limit and provider-ID acceptance tests. */
  verified: boolean;
  send(job: DeliveryJob): Promise<DeliveryResult>;
}
// Release gate: no production transport is certified for campaigns yet. In particular,
// never reuse the personal ZCAJS dispatcher (it can auto-create personal OA routing).
// Official Messenger and OA/ZBS adapters must be certified independently before replacing these.
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
};
export function channelEnabled(channel: Channel) {
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
