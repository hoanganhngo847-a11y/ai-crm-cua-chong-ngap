"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  runCampaignCommand,
  loadCampaignPreview,
} from "../../app/actions/campaigns";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Modal } from "../../components/ui/modal";
import {
  reasonLabels,
  templateVariables,
  variables,
  vietnamSchedule,
  type CampaignData,
  type Channel,
  type Template,
} from "./contracts";

const field =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-2 text-sm";

const variableLabels: Record<string, string> = {
  customer_name: "Tên khách hàng",
  customer_code: "Mã khách hàng",
  assigned_sale_name: "Sale phụ trách",
  company_name: "Tên công ty",
};

const channelLabels: Record<Channel, string> = {
  FACEBOOK: "Facebook Messenger",
  ZALO_OA: "Zalo Official Account / ZBS",
};

export function CampaignWizard({
  data,
  readiness,
  canExecute,
  canManageTemplates,
}: {
  data: CampaignData;
  readiness: Record<Channel, boolean>;
  canExecute: boolean;
  canManageTemplates: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [ids, setIds] = useState(data.customers.map((c) => c.id));
  const [templates, setTemplates] = useState<Template[]>(data.templates);
  const [channel, setChannel] = useState<Channel>("FACEBOOK");
  const [sender, setSender] = useState("");
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [mode, setMode] = useState("now");
  const [preview, setPreview] = useState<CampaignData | null>(null);
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [error, setError] = useState("");
  const [templateMessage, setTemplateMessage] = useState("");
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateChannel, setNewTemplateChannel] =
    useState<Channel>("FACEBOOK");
  const [newTemplateContent, setNewTemplateContent] = useState("");
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const c = preview?.campaign;
  const usableTemplates = templates.filter((item) =>
    ["ACTIVE", "PROVIDER_APPROVED"].includes(item.status),
  );
  const selectedTemplate = templates.find((item) => item.id === template);
  const availableSenders = data.senders.filter(
    (item) =>
      item.channel === channel &&
      (!selectedTemplate?.sender_account_id ||
        item.id === selectedTemplate.sender_account_id),
  );
  const senderName = data.senders.find((item) => item.id === sender)?.name;

  function chooseTemplate(id: string) {
    requestId.current = null;
    setPreview(null);
    setTemplate(id);
    const next = templates.find((item) => item.id === id);
    if (!next) {
      setSender("");
      return;
    }
    setChannel(next.channel);
    const candidates = data.senders.filter(
      (item) =>
        item.channel === next.channel &&
        (!next.sender_account_id || item.id === next.sender_account_id),
    );
    setSender(
      next.sender_account_id || (candidates.length === 1 ? candidates[0].id : ""),
    );
  }

  async function saveTemplate() {
    if (templateBusy) return;
    setTemplateMessage("");
    setError("");
    const cleanName = newTemplateName.trim();
    const cleanContent = newTemplateContent.trim();
    if (!cleanName || !cleanContent) {
      setTemplateMessage("Nhập tên mẫu và nội dung tin nhắn trước khi lưu.");
      return;
    }

    let detectedVariables: string[];
    try {
      detectedVariables = templateVariables(cleanContent);
    } catch {
      setTemplateMessage(
        "Nội dung có biến không hợp lệ. Chỉ dùng các biến được cung cấp bên dưới.",
      );
      return;
    }

    setTemplateBusy(true);
    try {
      const templateType =
        newTemplateChannel === "FACEBOOK" ? "MESSENGER_RESPONSE" : "OA_SERVICE";
      const result = await runCampaignCommand("template", {
        name: cleanName,
        channel: newTemplateChannel,
        sender_account_id: null,
        provider_template_id: null,
        template_type: templateType,
        parameter_mapping: {},
        content: cleanContent,
        status: "ACTIVE",
      });
      if (!result.ok || !result.id) {
        setTemplateMessage(result.message || "Không lưu được mẫu tin nhắn.");
        return;
      }

      const created: Template = {
        id: result.id,
        name: cleanName,
        channel: newTemplateChannel,
        sender_account_id: null,
        provider_template_id: null,
        template_type: templateType,
        parameter_mapping: {},
        content: cleanContent,
        status: "ACTIVE",
        variables: detectedVariables,
      };
      setTemplates((old) => [created, ...old]);
      setShowTemplateEditor(false);
      setNewTemplateName("");
      setNewTemplateContent("");
      setTemplateMessage("Đã lưu mẫu mới và chọn mẫu này cho chiến dịch.");
      setTemplate(created.id);
      setChannel(created.channel);
      const candidates = data.senders.filter(
        (item) => item.channel === created.channel,
      );
      setSender(candidates.length === 1 ? candidates[0].id : "");
      requestId.current = null;
    } finally {
      setTemplateBusy(false);
    }
  }

  async function prepare() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      const created = await runCampaignCommand("create", {
        request_id: requestId.current,
        name,
        channel,
        sender_account_id: sender,
        template_id: template,
        customer_ids: ids,
      });
      if (!created.ok || !created.id) throw new Error(created.message);

      const validated = await runCampaignCommand("validate", {
        id: created.id,
      });
      if (!validated.ok) throw new Error(validated.message);

      const loaded = await loadCampaignPreview(created.id);
      if (!loaded.ok || !loaded.data)
        throw new Error("Không tải được bản kiểm tra.");
      setPreview(loaded.data);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được chiến dịch.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function confirm() {
    if (!c || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await runCampaignCommand("confirm", {
        id: c.id,
        expected_version: c.validation_version,
        expected_eligible: c.eligible_count,
        scheduled_at: mode === "schedule" ? vietnamSchedule(schedule) : null,
      });
      if (!result.ok) throw new Error(result.message);
      router.push(`/campaigns/${c.id}`);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Không xác nhận được chiến dịch.",
      );
      setModal(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        {["Khách hàng", "Mẫu tin nhắn", "Kiểm tra", "Gửi tin nhắn"].map(
          (label, index) => (
            <li
              key={label}
              aria-current={step === index + 1 ? "step" : undefined}
              className={`rounded-lg border p-3 ${
                step === index + 1
                  ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                  : "border-[var(--border-subtle)]"
              }`}
            >
              {index + 1}. {label}
            </li>
          ),
        )}
      </ol>

      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}

      <Card className="space-y-4 p-5">
        {step === 1 && (
          <>
            <div>
              <h2 className="font-semibold">{ids.length} khách hàng đã chọn</h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Kiểm tra danh sách trước khi chuyển sang chọn mẫu tin nhắn.
              </p>
            </div>
            {data.customers
              .filter((customer) => ids.includes(customer.id))
              .map((customer) => (
                <div
                  key={customer.id}
                  className="flex items-center justify-between border-b border-[var(--border-subtle)] py-2 text-sm"
                >
                  <div>
                    {customer.name} · {customer.customer_code}
                    <p className="text-xs text-[var(--text-secondary)]">
                      {customer.channels.join(", ") || "Chưa có định danh"} ·{" "}
                      {customer.assigned_sale_name || "Chưa phân công"} ·{" "}
                      {customer.stage}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      requestId.current = null;
                      setIds((old) => old.filter((id) => id !== customer.id));
                    }}
                  >
                    Bỏ
                  </Button>
                </div>
              ))}
            {ids.length === 0 && (
              <Link className="text-[var(--accent)]" href="/customers/dossier">
                Quay lại Customer 360 để chọn khách hàng
              </Link>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <h2 className="font-semibold">Chọn mẫu tin nhắn</h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Chọn mẫu đã lưu hoặc tạo mẫu mới ngay tại đây. Kênh gửi được lấy
                theo mẫu đã chọn.
              </p>
            </div>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Tên chiến dịch</span>
              <input
                maxLength={120}
                className={field}
                value={name}
                placeholder="Ví dụ: Chăm sóc khách chưa chốt tháng 10"
                onChange={(e) => {
                  requestId.current = null;
                  setPreview(null);
                  setName(e.target.value);
                }}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Mẫu tin nhắn đã lưu</span>
              <select
                aria-label="Mẫu tin nhắn đã lưu"
                className={field}
                value={template}
                onChange={(e) => chooseTemplate(e.target.value)}
              >
                <option value="">Chọn mẫu tin nhắn</option>
                {usableTemplates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {channelLabels[item.channel]}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              {canManageTemplates && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowTemplateEditor((old) => !old);
                    setTemplateMessage("");
                  }}
                >
                  {showTemplateEditor ? "Đóng tạo mẫu" : "+ Tạo mẫu tin nhắn mới"}
                </Button>
              )}
              <Link
                className="self-center text-sm text-[var(--accent)]"
                href="/campaigns/templates"
              >
                Mở thư viện mẫu
              </Link>
            </div>

            {showTemplateEditor && canManageTemplates && (
              <div className="space-y-4 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] p-4">
                <h3 className="font-medium">Tạo và lưu mẫu mới</h3>
                <label className="block space-y-1">
                  <span className="text-sm">Tên mẫu</span>
                  <input
                    className={field}
                    maxLength={120}
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">Kênh</span>
                  <select
                    className={field}
                    value={newTemplateChannel}
                    onChange={(e) =>
                      setNewTemplateChannel(e.target.value as Channel)
                    }
                  >
                    <option value="FACEBOOK">Facebook Messenger</option>
                    <option value="ZALO_OA">Zalo Official Account / ZBS</option>
                  </select>
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">Nội dung tin nhắn</span>
                  <textarea
                    className={field}
                    rows={7}
                    maxLength={2000}
                    value={newTemplateContent}
                    onChange={(e) => setNewTemplateContent(e.target.value)}
                    placeholder="Nhập nội dung bạn muốn gửi..."
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {variables.map((variable) => (
                    <Button
                      key={variable}
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        setNewTemplateContent(
                          (old) => `${old}${old ? " " : ""}{{${variable}}}`,
                        )
                      }
                    >
                      + {variableLabels[variable] || variable}
                    </Button>
                  ))}
                </div>
                <Button
                  type="button"
                  disabled={templateBusy}
                  onClick={saveTemplate}
                >
                  {templateBusy ? "Đang lưu…" : "Lưu và dùng mẫu này"}
                </Button>
              </div>
            )}

            {templateMessage && (
              <p role="status" className="text-sm">
                {templateMessage}
              </p>
            )}

            {selectedTemplate && (
              <div className="space-y-3 rounded-lg border border-[var(--border-subtle)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{selectedTemplate.name}</strong>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {channelLabels[channel]}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap text-sm">
                  {selectedTemplate.content}
                </pre>
              </div>
            )}

            {template && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">Tài khoản gửi</span>
                <select
                  aria-label="Tài khoản gửi"
                  className={field}
                  value={sender}
                  onChange={(e) => {
                    requestId.current = null;
                    setPreview(null);
                    setSender(e.target.value);
                  }}
                >
                  <option value="">Chọn Page / OA</option>
                  {availableSenders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {!item.connected || !item.verified
                        ? " — chưa sẵn sàng gửi thật"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {template && !readiness[channel] && (
              <p
                role="status"
                className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm"
              >
                {channelLabels[channel]} hiện chưa sẵn sàng cho gửi hàng loạt.
                Bạn vẫn có thể lưu bản nháp, kiểm tra người nhận và preview; nút
                gửi thật sẽ tiếp tục bị khóa.
              </p>
            )}

            {!usableTemplates.length && !canManageTemplates && (
              <p className="text-sm text-[var(--text-secondary)]">
                Chưa có mẫu sẵn sàng. BOSS_ADMIN cần tạo mẫu trước khi chiến dịch
                có thể tiếp tục.
              </p>
            )}
          </>
        )}

        {step === 3 && preview && c && (
          <>
            <div>
              <h2 className="font-semibold">Kiểm tra trước khi gửi</h2>
              <p className="text-sm">
                Đã chọn {c.selected_count} · Có thể gửi {c.eligible_count} · Bị
                loại {c.selected_count - c.eligible_count}
              </p>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              {Object.entries(
                preview.recipients.reduce<Record<string, number>>((acc, item) => {
                  acc[item.eligibility_status] =
                    (acc[item.eligibility_status] || 0) + 1;
                  return acc;
                }, {}),
              ).map(([key, count]) => (
                <span key={key}>
                  {reasonLabels[key] || key}: {count}
                </span>
              ))}
            </div>
            <p className="text-xs text-[var(--text-secondary)]">
              Nội dung bên dưới là bản cá nhân hóa đã đóng băng. Eligibility sẽ
              còn được kiểm tra lại ở thời điểm dispatch.
            </p>
            {preview.recipients.map((recipient) => (
              <div
                key={recipient.id}
                className="rounded border border-[var(--border-subtle)] p-3"
              >
                <strong>{recipient.recipient_snapshot.name}</strong>
                <p className="text-xs">
                  {reasonLabels[recipient.eligibility_status] ||
                    recipient.eligibility_status}
                  {recipient.eligibility_reason
                    ? ` · ${
                        reasonLabels[recipient.eligibility_reason] ||
                        recipient.eligibility_reason
                      }`
                    : ""}
                </p>
                {recipient.personalized_payload && (
                  <p className="mt-2 whitespace-pre-wrap text-sm">
                    {recipient.personalized_payload.text}
                  </p>
                )}
              </div>
            ))}
          </>
        )}

        {step === 4 && c && (
          <>
            <div>
              <h2 className="font-semibold">Gửi tin nhắn</h2>
              <p className="text-sm">
                {c.name} · {channelLabels[c.channel]} · {senderName || "—"}
              </p>
              <p className="text-sm">
                Mẫu: {c.template_snapshot.name} · Có thể gửi {c.eligible_count}/
                {c.selected_count} khách hàng
              </p>
            </div>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Thời điểm</span>
              <select
                aria-label="Thời điểm"
                className={field}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="now">Gửi ngay</option>
                <option value="schedule">Đặt lịch</option>
              </select>
            </label>

            {mode === "schedule" && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">
                  Thời gian tại Việt Nam (Asia/Ho_Chi_Minh)
                </span>
                <input
                  type="datetime-local"
                  className={field}
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                />
              </label>
            )}

            {!canExecute && (
              <p className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm">
                Bản nháp đã được tạo nhưng tài khoản hiện tại chưa có quyền thực
                thi chiến dịch.
              </p>
            )}
            {!readiness[c.channel] && (
              <p
                role="status"
                className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm"
              >
                {channelLabels[c.channel]} chưa được bật/xác minh để gửi thật.
                Nút gửi được khóa an toàn; bản nháp và preview vẫn được giữ.
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                disabled={
                  busy ||
                  !canExecute ||
                  !readiness[c.channel] ||
                  c.eligible_count === 0 ||
                  (mode === "schedule" && !schedule)
                }
                onClick={() => setModal(true)}
              >
                {mode === "schedule" ? "Đặt lịch gửi" : "Gửi tin nhắn"} cho{" "}
                {c.eligible_count} người
              </Button>
              <Link
                className="self-center text-sm text-[var(--accent)]"
                href={`/campaigns/${c.id}`}
              >
                Lưu và xem bản nháp
              </Link>
            </div>
          </>
        )}
      </Card>

      <div className="flex flex-wrap gap-3">
        {step > 1 && (
          <Button
            disabled={busy || templateBusy}
            variant="outline"
            onClick={() => {
              if (step === 3) {
                requestId.current = null;
                setPreview(null);
              }
              setStep(step - 1);
            }}
          >
            Quay lại
          </Button>
        )}

        {step === 1 && (
          <Button disabled={busy || !ids.length} onClick={() => setStep(2)}>
            Tiếp tục: chọn mẫu tin nhắn
          </Button>
        )}

        {step === 2 && (
          <Button
            disabled={busy || templateBusy || !name.trim() || !template || !sender}
            onClick={prepare}
          >
            {busy ? "Đang kiểm tra…" : "Lưu bản nháp và kiểm tra"}
          </Button>
        )}

        {step === 3 && (
          <Button onClick={() => setStep(4)}>Tiếp tục: gửi tin nhắn</Button>
        )}

        {step >= 3 && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              requestId.current = null;
              setPreview(null);
              setStep(1);
            }}
          >
            Bắt đầu lại với danh sách này
          </Button>
        )}
      </div>

      <Modal
        isOpen={modal}
        onClose={() => {
          if (!busy) setModal(false);
        }}
        title="Xác nhận gửi chiến dịch"
        footer={
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setModal(false)}
            >
              Quay lại
            </Button>
            <Button disabled={busy} onClick={confirm}>
              {mode === "schedule" ? "Đặt lịch" : "Gửi"}{" "}
              {c?.eligible_count || 0} tin nhắn
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p>
            Kênh: {c ? channelLabels[c.channel] : channelLabels[channel]} · Tài
            khoản: {senderName || "—"} · Mẫu: {c?.template_snapshot.name || "—"}
          </p>
          <p>
            Đã chọn: {c?.selected_count || 0} · Có thể gửi:{" "}
            {c?.eligible_count || 0} · Bị loại:{" "}
            {(c?.selected_count || 0) - (c?.eligible_count || 0)}
          </p>
          <p>
            Bạn chuẩn bị {mode === "schedule" ? "đặt lịch" : "gửi"}{" "}
            {c?.eligible_count || 0} tin nhắn.
          </p>
        </div>
      </Modal>
    </div>
  );
}
