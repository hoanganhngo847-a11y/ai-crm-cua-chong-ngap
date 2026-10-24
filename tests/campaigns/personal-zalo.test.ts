import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { channelSchema, templateSchema } from "../../features/campaigns/contracts";
import { processCampaignBatch } from "../../features/campaigns/worker";
import type { CampaignAdapter, DeliveryJob } from "../../features/campaigns/adapters";

const companyId = "bc000000-0000-4000-8000-000000000101";
const recipientId = "bc000000-0000-4000-8000-000000000102";
const token = "bc000000-0000-4000-8000-000000000103";

const personalJob: DeliveryJob = {
  id: recipientId,
  company_id: companyId,
  campaign_id: "bc000000-0000-4000-8000-000000000104",
  lock_token: token,
  channel: "ZALO_PERSONAL",
  sender_external_id: `zcajs:${companyId}`,
  recipient_external_id: "123456789",
  personalized_payload: { text: "Xin chào khách hàng" },
  template_snapshot: { template_type: "ZALO_PERSONAL_TEXT" },
};

function mockDb() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let claimed = false;
  return {
    calls,
    db: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "campaign_claim") {
          if (claimed) return { data: null, error: null };
          claimed = true;
          return {
            data: { id: personalJob.id, lock_token: personalJob.lock_token },
            error: null,
          };
        }
        if (name === "campaign_begin") return { data: personalJob, error: null };
        if (name === "campaign_finish") return { data: true, error: null };
        throw new Error(`UNEXPECTED_RPC:${name}`);
      },
    } as unknown as SupabaseClient,
  };
}

function personalEnv(enabled: boolean) {
  process.env.ZALO_TRANSPORT = "ZCAJS";
  process.env.ZALO_PERSONAL_CAMPAIGNS_ENABLED = enabled ? "true" : "false";
}

test("contracts expose ZALO_PERSONAL without treating ZCAJS as a public campaign channel", () => {
  assert.equal(channelSchema.safeParse("ZALO_PERSONAL").success, true);
  assert.equal(channelSchema.safeParse("ZCAJS").success, false);
  assert.equal(
    templateSchema.safeParse({
      name: "Zalo personal",
      channel: "ZALO_PERSONAL",
      sender_account_id: null,
      provider_template_id: null,
      template_type: "ZALO_PERSONAL_TEXT",
      content: "Chào {{customer_name}}",
      parameter_mapping: {},
      status: "ACTIVE",
    }).success,
    true,
  );
});

test("personal Zalo campaign is fail-closed until its dedicated flag is enabled", async () => {
  personalEnv(false);
  const { db, calls } = mockDb();
  const adapter: CampaignAdapter = {
    verified: true,
    async send() {
      throw new Error("must not send while disabled");
    },
  };

  const result = await processCampaignBatch(
    { companyId, channel: "ZALO_PERSONAL", limit: 1 },
    { db, adapter },
  );
  assert.deepEqual(result, { status: "DISABLED", processed: 0 });
  assert.equal(calls.length, 0);
});

test("personal Zalo worker processes one due recipient through the fenced campaign protocol", async () => {
  personalEnv(true);
  const { db, calls } = mockDb();
  let sent = 0;
  const adapter: CampaignAdapter = {
    verified: true,
    async send(job) {
      sent++;
      assert.equal(job.channel, "ZALO_PERSONAL");
      assert.equal(job.recipient_external_id, "123456789");
      return { status: "SENT", messageId: "zcajs-provider-123" };
    },
  };

  const result = await processCampaignBatch(
    { companyId, channel: "ZALO_PERSONAL", limit: 1 },
    { db, adapter },
  );

  assert.deepEqual(result, { status: "PROCESSED", processed: 1 });
  assert.equal(sent, 1);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["campaign_claim", "campaign_begin", "campaign_finish"],
  );
  const finish = calls.at(-1)!.args;
  assert.equal(finish.p_status, "SENT");
  assert.equal(finish.p_message_id, "zcajs-provider-123");
});
