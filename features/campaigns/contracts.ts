import { z } from "zod";

export const channelSchema = z.enum(["FACEBOOK", "ZALO_OA"]);
export const variables = [
  "customer_name",
  "customer_code",
  "assigned_sale_name",
  "company_name",
] as const;
export const templateSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    channel: channelSchema,
    sender_account_id: z.string().uuid().nullable(),
    provider_template_id: z.string().trim().min(1).max(150).nullable(),
    template_type: z.enum(["MESSENGER_RESPONSE", "OA_SERVICE", "ZBS_TEMPLATE"]),
    content: z.string().trim().min(1).max(2000),
    parameter_mapping: z
      .record(z.string().regex(/^[A-Za-z0-9_]{1,80}$/), z.enum(variables))
      .default({}),
    status: z.enum(["DRAFT", "ACTIVE", "DISABLED", "PROVIDER_PENDING"]),
  })
  .strict();
export const createSchema = z
  .object({
    request_id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    channel: channelSchema,
    sender_account_id: z.string().uuid(),
    template_id: z.string().uuid(),
    customer_ids: z.array(z.string().uuid()).min(1).max(500),
  })
  .strict();
export const confirmSchema = z
  .object({
    id: z.string().uuid(),
    expected_version: z.number().int().positive(),
    expected_eligible: z.number().int().positive().max(500),
    scheduled_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export function templateVariables(content: string): string[] {
  const found = [...content.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]);
  if (
    /[{}]/.test(content.replace(/\{\{([a-z_]+)\}\}/g, "")) ||
    found.some((v) => !variables.includes(v as (typeof variables)[number]))
  ) {
    throw new Error("UNKNOWN_VARIABLE");
  }
  return [...new Set(found)];
}
export function renderTemplate(
  content: string,
  values: Record<string, string | null>,
): string {
  for (const key of templateVariables(content))
    if (!values[key]?.trim()) throw new Error("MISSING_VARIABLE");
  // Single pass: substituted customer data is never evaluated as a template.
  return content.replace(
    /\{\{([a-z_]+)\}\}/g,
    (_, key: string) => values[key]!,
  );
}
export type Channel = z.infer<typeof channelSchema>;
export type Campaign = {
  id: string;
  name: string;
  channel: Channel;
  status: string;
  sender_account_id: string;
  template_snapshot: {
    name: string;
    content: string;
    template_type: string;
    provider_template_id: string | null;
  };
  validation_version: number;
  selected_count: number;
  eligible_count: number;
  sent_count: number;
  delivered_count: number;
  failed_count: number;
  skipped_count: number;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
};
export type SuppressionInfo = {
  status: string;
  source: string;
  created_at: string;
  revoked_at: string | null;
};
export type Recipient = {
  id: string;
  customer_id: string;
  recipient_snapshot: {
    name: string;
    customer_code: string;
    stage: string;
    assigned_sale_name: string | null;
    channels: string[];
  };
  personalized_payload: { text: string } | null;
  eligibility_status: string;
  eligibility_reason: string | null;
  delivery_status: string;
  attempt_count: number;
  provider_message_id: string | null;
  provider_error_code: string | null;
  provider_error_message_sanitized: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  suppression?: SuppressionInfo | null;
};
export type Template = z.infer<typeof templateSchema> & {
  id: string;
  status: string;
  variables: string[];
};
export type Sender = {
  id: string;
  name: string;
  channel: Channel;
  connected: boolean;
  verified: boolean;
};
export type RecipientOption = {
  id: string;
  name: string;
  customer_code: string;
  stage: string;
  assigned_sale_name: string | null;
  channels: string[];
};
export type CampaignData = {
  campaigns: Campaign[];
  templates: Template[];
  senders: Sender[];
  customers: RecipientOption[];
  campaign: Campaign | null;
  recipients: Recipient[];
  audit: { event: string; created_at: string; actor_user_id: string | null }[];
  enabled: boolean;
  sale_execute: boolean;
};
export const reasonLabels: Record<string, string> = {
  ELIGIBLE: "Có thể gửi",
  MISSING_IDENTITY: "Không có định danh kênh",
  IDENTITY_UNVERIFIED: "Định danh chưa được xác minh bởi provider",
  IDENTITY_CONFLICT: "Định danh mâu thuẫn giữa các khách hàng",
  SENDER_MISMATCH: "Định danh thuộc Page/OA khác",
  BLOCKED_POLICY: "Không đủ điều kiện policy",
  UNSUBSCRIBED: "Đã unsubscribe / chặn liên hệ",
  DUPLICATE: "Trùng người nhận",
  TEMPLATE_DISABLED: "Mẫu đã bị tắt hoặc thay đổi phê duyệt",
  OUTSIDE_WINDOW: "Ngoài cửa sổ nhắn tin",
  NO_CONSENT: "Chưa có bằng chứng đồng ý / eligibility",
  SENDER_UNAVAILABLE: "Tài khoản gửi chưa sẵn sàng",
  MISSING_VARIABLE: "Thiếu dữ liệu cá nhân hóa",
  UNCERTAIN: "Chờ đối soát với provider, không tự gửi lại",
  TRANSPORT_DISABLED: "Kênh gửi chưa được xác minh",
};
export function vietnamSchedule(local: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    throw new Error("INVALID_SCHEDULE");
  const parsed = new Date(`${local}:00+07:00`);
  if (!Number.isFinite(parsed.getTime())) throw new Error("INVALID_SCHEDULE");
  return parsed.toISOString();
}

export function resolveCampaignIdentity({
  channel,
  senderExternalId,
  customerIdentities,
  resolvedOaId,
}: {
  channel: Channel;
  senderExternalId: string;
  customerIdentities: Array<{
    id: string;
    channel: string;
    external_id: string;
    verified: boolean;
    metadata?: Record<string, unknown> | null;
  }>;
  resolvedOaId?: string | null;
}):
  | { status: "MATCH"; identity: (typeof customerIdentities)[number] }
  | {
      status:
        | "MISSING_IDENTITY"
        | "SENDER_MISMATCH"
        | "IDENTITY_UNVERIFIED";
      identity: null;
    } {
  if (channel === "FACEBOOK") {
    const channelIds = customerIdentities.filter(
      (i) => i.channel === "FACEBOOK",
    );
    if (channelIds.length === 0)
      return { status: "MISSING_IDENTITY", identity: null };

    const match = channelIds.find(
      (i) =>
        (i.external_id ===
          `${senderExternalId}:${i.external_id.split(":")[1]}` ||
          i.external_id.startsWith(`${senderExternalId}:`)) &&
        /^[0-9]+:[0-9]+$/.test(i.external_id),
    );
    if (!match) return { status: "SENDER_MISMATCH", identity: null };
    if (!match.verified)
      return { status: "IDENTITY_UNVERIFIED", identity: null };
    return { status: "MATCH", identity: match };
  }

  // ZALO_OA: canonical Zalo UID identity + resolved official OA scope
  const channelIds = customerIdentities.filter((i) => i.channel === "ZALO");
  if (channelIds.length === 0)
    return { status: "MISSING_IDENTITY", identity: null };

  const match = channelIds.find(
    (i) =>
      /^[0-9]+$/.test(i.external_id) &&
      i.metadata?.source !== "ZCAJS" &&
      i.metadata?.provider !== "zcajs",
  );
  if (!match) return { status: "IDENTITY_UNVERIFIED", identity: null };

  const effectiveOa =
    resolvedOaId ||
    (match.metadata?.source === "ZALO_OA" &&
    typeof match.metadata?.oa_id === "string"
      ? match.metadata.oa_id
      : null);

  if (!effectiveOa || effectiveOa !== senderExternalId) {
    return { status: "SENDER_MISMATCH", identity: null };
  }
  if (!match.verified)
    return { status: "IDENTITY_UNVERIFIED", identity: null };

  return { status: "MATCH", identity: match };
}
