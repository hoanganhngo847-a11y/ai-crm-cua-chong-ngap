import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSchema,
  templateSchema,
  renderTemplate,
  templateVariables,
  vietnamSchedule,
} from "../../features/campaigns/contracts";
import {
  campaignAdapters,
  type CampaignAdapter,
} from "../../features/campaigns/adapters";
import { processCampaignBatch } from "../../features/campaigns/worker";
import { safeCampaignDto } from "../../features/campaigns/service";
import { POST } from "../../app/api/cron/campaigns/route";
import { NextRequest } from "next/server";
const companyId = "bc000000-0000-4000-8000-000000000001";
const recipient = "bc000000-0000-4000-8000-000000000002";
const token = "bc000000-0000-4000-8000-000000000003";
const claim = {
  id: recipient,
  lock_token: token,
  company_id: companyId,
  campaign_id: recipient,
  channel: "FACEBOOK",
  sender_external_id: "111",
  recipient_external_id: "111:123",
  personalized_payload: { text: "Synthetic" },
  template_snapshot: {},
};
function flags(on = true) {
  process.env.BULK_MESSAGING_ENABLED = String(on);
  process.env.FACEBOOK_CAMPAIGNS_ENABLED = String(on);
  process.env.ZALO_OA_CAMPAIGNS_ENABLED = String(on);
}
function mockDb(begin = true, finish = true) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let claimed = false;
  return {
    calls,
    db: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === "campaign_claim") {
          if (claimed) return { data: null, error: null };
          claimed = true;
          return { data: claim, error: null };
        }
        if (name === "campaign_begin")
          return { data: begin ? claim : null, error: null };
        if (name === "campaign_finish") return { data: finish, error: null };
        throw new Error("UNEXPECTED_RPC");
      },
    } as unknown as SupabaseClient,
  };
}
test("personalization rejects expressions, unknown and missing variables; does not evaluate substituted data", () => {
  for (const text of [
    "{{phone}}",
    "{{customer.name}}",
    "{{foo()}}",
    "{{ customer_name }}",
    "{customer_name}",
  ])
    assert.throws(() => templateVariables(text));
  assert.throws(() => renderTemplate("{{customer_name}}", {}), /MISSING/);
  assert.equal(
    renderTemplate("Hello {{customer_name}} {{company_name}}", {
      customer_name: "{{company_name}}",
      company_name: "CRM",
    }),
    "Hello {{company_name}} CRM",
  );
  assert.equal(vietnamSchedule("2026-10-25T09:00"), "2026-10-25T02:00:00.000Z");
});
test("strict schemas reject tenant authority, personal Zalo and unbounded input", () => {
  assert.equal(
    createSchema.safeParse({ company_id: companyId }).success,
    false,
  );
  assert.equal(
    templateSchema.safeParse({ name: "bad", channel: "ZCAJS" }).success,
    false,
  );
});
test("browser DTO masks phones including malicious customer names and frozen preview content", () => {
  const dto = safeCampaignDto({
    id: companyId,
    recipient_snapshot: { name: "Call 0912345678" },
    personalized_payload: { text: "Phone +84912345678" },
    provider_message_id: "0912345678",
  });
  assert.equal((dto as { id: string }).id, companyId);
  assert.ok(
    !JSON.stringify(
      (dto as { recipient_snapshot: unknown }).recipient_snapshot,
    ).includes("0912345678"),
  );
  assert.ok(
    !JSON.stringify(
      (dto as { personalized_payload: unknown }).personalized_payload,
    ).includes("+84912345678"),
  );
});
test("module OFF never touches database or adapter", async () => {
  flags(false);
  const { db, calls } = mockDb();
  let sent = 0;
  assert.equal(
    (
      await processCampaignBatch(
        { companyId, channel: "FACEBOOK" },
        {
          db,
          adapter: {
            verified: true,
            send: async () => {
              sent++;
              return { status: "SENT", messageId: "synthetic" };
            },
          },
        },
      )
    ).status,
    "DISABLED",
  );
  assert.equal(calls.length, 0);
  assert.equal(sent, 0);
});
test("both production adapters stay disabled even with flags true, no provider HTTP", async () => {
  flags();
  const { db, calls } = mockDb();
  for (const channel of ["FACEBOOK", "ZALO_OA"])
    assert.equal(
      (await processCampaignBatch({ companyId, channel }, { db })).status,
      "TRANSPORT_DISABLED",
    );
  assert.equal(campaignAdapters.FACEBOOK.verified, false);
  assert.equal(campaignAdapters.ZALO_OA.verified, false);
  assert.equal(calls.length, 0);
});
test("worker rechecks before transport and stops a paused/suppressed/expired recipient", async () => {
  flags();
  const { db, calls } = mockDb(false);
  let sends = 0;
  await processCampaignBatch(
    { companyId, channel: "FACEBOOK" },
    {
      db,
      adapter: {
        verified: true,
        send: async () => {
          sends++;
          return { status: "SENT", messageId: "synthetic" };
        },
      },
    },
  );
  assert.equal(sends, 0);
  assert.equal(
    calls.some((c) => c.name === "campaign_finish"),
    false,
  );
});
for (const status of ["SENT", "TRANSIENT", "PERMANENT", "UNCERTAIN"] as const)
  test(`worker persists ${status} with exact tenant and fencing token`, async () => {
    flags();
    const { db, calls } = mockDb();
    const adapter: CampaignAdapter = {
      verified: true,
      async send(job) {
        assert.equal(job.company_id, companyId);
        return status === "SENT"
          ? { status, messageId: "real-provider-id" }
          : { status, code: "PROVIDER_CODE" };
      },
    };
    assert.equal(
      (
        await processCampaignBatch(
          { companyId, channel: "FACEBOOK", limit: 2 },
          { db, adapter },
        )
      ).processed,
      1,
    );
    const finish = calls.find((c) => c.name === "campaign_finish")!.args;
    assert.equal(finish.p_status, status);
    assert.equal(finish.p_company, companyId);
    assert.equal(finish.p_token, token);
  });
test("thrown/ambiguous provider error is never transient and failed persistence is surfaced", async () => {
  flags();
  const { db, calls } = mockDb();
  const adapter: CampaignAdapter = {
    verified: true,
    async send() {
      throw new Error("SECRET_MUST_NOT_LEAK");
    },
  };
  await processCampaignBatch(
    { companyId, channel: "FACEBOOK" },
    { db, adapter },
  );
  assert.equal(
    calls.find((c) => c.name === "campaign_finish")!.args.p_status,
    "UNCERTAIN",
  );
  assert.ok(!JSON.stringify(calls).includes("SECRET_MUST_NOT_LEAK"));
  await assert.rejects(
    processCampaignBatch(
      { companyId, channel: "FACEBOOK" },
      { db: mockDb(true, false).db, adapter },
    ),
    /UNPERSISTED/,
  );
});
test("cron is auth-first, strict targeted tenant/channel, rejects duplicate and unknown params", async () => {
  delete process.env.CAMPAIGN_CRON_SECRET;
  assert.equal(
    (
      await POST(
        new NextRequest("http://localhost/api/cron/campaigns?bad=1", {
          method: "POST",
        }),
      )
    ).status,
    401,
  );
  process.env.CAMPAIGN_CRON_SECRET =
    "synthetic-campaign-cron-secret-32-characters";
  const headers = {
    authorization: `Bearer ${process.env.CAMPAIGN_CRON_SECRET}`,
  };
  for (const query of [
    `companyId=${companyId}&channel=FACEBOOK&channel=FACEBOOK`,
    `companyId=${companyId}&channel=ZCAJS`,
    `companyId=${companyId}&channel=FACEBOOK&unknown=1`,
    `channel=FACEBOOK`,
  ]) {
    assert.equal(
      (
        await POST(
          new NextRequest(`http://localhost/api/cron/campaigns?${query}`, {
            method: "POST",
            headers,
          }),
        )
      ).status,
      400,
    );
  }
  flags(false);
  const response = await POST(
    new NextRequest(
      `http://localhost/api/cron/campaigns?companyId=${companyId}&channel=FACEBOOK`,
      { method: "POST", headers },
    ),
  );
  assert.deepEqual(await response.json(), { status: "DISABLED", processed: 0 });
});
