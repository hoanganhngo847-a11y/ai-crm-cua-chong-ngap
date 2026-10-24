"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  runCampaignCommand,
  loadCampaignPreview,
  syncPersonalZaloContactsAction,
  linkPersonalZaloContactAction,
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

type ContactCandidate = {
  id: string;
  display_name: string | null;
  last_seen_at: string;
};

type LinkTarget = {
  customerId: string;
  customerName: string;
};

export function PersonalZaloCampaignWizard({
  data,
  ready,
  canExecute,
  canManageTemplates,
}: {
  data: CampaignData;
  ready: boolean;
  canExecute: boolean;
  canManageTemplates: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [ids, setIds] = useState(data.customers.map((c) => c.id));
  const [templates, setTemplates] = useState<Template[]>(
    data.templates.filter((t) => t.channel === "ZALO_PERSONAL"),
  );
  const personalSenders = data.senders.filter(
    (s) => s.channel === "ZALO_PERSONAL",
  );
  const [sender, setSender] = useState(
    personalSenders.length === 1 ? personalSenders[0].id : "",
  );
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [mode, setMode] = useState("now");
  const [preview, setPreview] = useState<CampaignData | null>(null);
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [error, setError] = useState("");
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateContent, setNewTemplateContent] = useState("");
  const [templateMessage, setTemplateMessage] = useState("");
  const [contactBusy, setContactBusy] = useState(false);
  const [contactCandidates, setContactCandidates] = useState<ContactCandidate[]>([]);
  const [contactMessage, setContactMessage] = useState("");
  const [linkModal, setLinkModal] = useState(false);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);

  const campaign = preview?.campaign;
  const usableTemplates = templates.filter((t) => t.status === "ACTIVE");
  const selectedTemplate = templates.find((t) => t.id === template);
  const senderName = personalSenders.find((s) => s.id === sender)?.name;
  const estimatedMinutes = Math.max(0, ((campaign?.eligible_count || 0) - 1) * 5);

  async function saveTemplate() {
    if (templateBusy) return;
    setTemplateMessage("");
    const cleanName = newTemplateName.trim();
    const cleanContent = newTemplateContent.trim();
    if (!cleanName || !cleanContent) {
      setTemplateMessage("Nhập tên mẫu và nội dung trước khi lưu.");
      return;
    }
    let detectedVariables: string[];
    try {
      detectedVariables = templateVariables(cleanContent);
    } catch {
      setTemplateMessage("Nội dung có biến không hợp lệ.");
      return;
    }
    setTemplateBusy(true);
    try {
      const result = await runCampaignCommand("template", {
        name: cleanName,
        channel: "ZALO_PERSONAL",
        sender_account_id: null,
        provider_template_id: null,
        template_type: "ZALO_PERSONAL_TEXT",
        parameter_mapping: {},
        content: cleanContent,
        status: "ACTIVE",
      });
      if (!result.ok || !result.id) {
        setTemplateMessage(result.message || "Không lưu được mẫu.");
        return;
      }
      const created: Template = {
        id: result.id,
        name: cleanName,
        channel: "ZALO_PERSONAL",
        sender_account_id: null,
        provider_template_id: null,
        template_type: "ZALO_PERSONAL_TEXT",
        parameter_mapping: {},
        content: cleanContent,
        status: "ACTIVE",
        variables: detectedVariables,
      };
      setTemplates((old) => [created, ...old]);
      setTemplate(created.id);
      setShowTemplateEditor(false);
      setNewTemplateName("");
      setNewTemplateContent("");
      setTemplateMessage("Đã lưu và chọn mẫu mới.");
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
        channel: "ZALO_PERSONAL",
        sender_account_id: sender,
        template_id: template,
        customer_ids: ids,
      });
      if (!created.ok || !created.id) throw new Error(created.message);
      const validated = await runCampaignCommand("validate", { id: created.id });
      if (!validated.ok) throw new Error(validated.message);
      const loaded = await loadCampaignPreview(created.id);
      if (!loaded.ok || !loaded.data) throw new Error("Không tải được bản kiểm tra.");
      setPreview(loaded.data);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được chiến dịch.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function refreshContacts(target?: LinkTarget) {
    if (contactBusy) return;
    if (target) {
      setLinkTarget(target);
      setSelectedCandidate("");
      setLinkModal(true);
    }
    setContactBusy(true);
    setContactMessage("Đang đồng bộ danh bạ Zalo cá nhân…");
    try {
      const result = await syncPersonalZaloContactsAction();
      if (!result.ok) {
        setContactMessage(result.message);
        return;
      }
      setContactCandidates(result.candidates);
      setContactMessage(
        result.candidates.length > 0
          ? `Đã đồng bộ ${result.seen} liên hệ; còn ${result.candidates.length} liên hệ chưa gắn với Customer 360.`
          : `Đã đồng bộ ${result.seen} liên hệ. Không còn liên hệ nào chờ gắn.`,
      );

      if (campaign) {
        const validated = await runCampaignCommand("validate", { id: campaign.id });
        if (validated.ok) {
          const loaded = await loadCampaignPreview(campaign.id);
          if (loaded.ok && loaded.data) setPreview(loaded.data);
        }
      }
    } finally {
      setContactBusy(false);
    }
  }

  async function linkSelectedContact() {
    if (!campaign || !linkTarget || !selectedCandidate || contactBusy) return;
    setContactBusy(true);
    setContactMessage("Đang liên kết tài khoản Zalo với khách hàng…");
    try {
      const result = await linkPersonalZaloContactAction({
        candidateId: selectedCandidate,
        customerId: linkTarget.customerId,
      });
      if (!result.ok) {
        setContactMessage(result.message);
        return;
      }

      const validated = await runCampaignCommand("validate", { id: campaign.id });
      if (!validated.ok) {
        setContactMessage("Đã liên kết Zalo nhưng chưa kiểm tra lại được chiến dịch. Hãy tải lại trang.");
        return;
      }
      const loaded = await loadCampaignPreview(campaign.id);
      if (!loaded.ok || !loaded.data) {
        setContactMessage("Đã liên kết Zalo nhưng chưa tải lại được bản kiểm tra.");
        return;
      }

      setPreview(loaded.data);
      setContactCandidates((old) => old.filter((item) => item.id !== selectedCandidate));
      setContactMessage(`Đã liên kết Zalo cho ${linkTarget.customerName} và kiểm tra lại chiến dịch.`);
      setSelectedCandidate("");
      setLinkTarget(null);
      setLinkModal(false);
    } finally {
      setContactBusy(false);
    }
  }

  async function confirm() {
    if (!campaign || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await runCampaignCommand("confirm", {
        id: campaign.id,
        expected_version: campaign.validation_version,
        expected_eligible: campaign.eligible_count,
        scheduled_at: mode === "schedule" ? vietnamSchedule(schedule) : null,
      });
      if (!result.ok) throw new Error(result.message);
      router.push(`/campaigns/${campaign.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không xác nhận được chiến dịch.");
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

      {error && <p role="alert" className="text-red-700">{error}</p>}

      <Card className="space-y-4 p-5">
        {step === 1 && (
          <>
            <div>
              <h2 className="font-semibold">{ids.length} khách hàng đã chọn</h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Chỉ khách có định danh Zalo cá nhân hợp lệ mới được đưa vào hàng đợi gửi.
              </p>
            </div>
            {data.customers.filter((c) => ids.includes(c.id)).map((customer) => (
              <div key={customer.id} className="flex items-center justify-between border-b border-[var(--border-subtle)] py-2 text-sm">
                <div>
                  {customer.name} · {customer.customer_code}
                  <p className="text-xs text-[var(--text-secondary)]">
                    {customer.channels.join(", ") || "Chưa có định danh"} · {customer.stage}
                  </p>
                </div>
                <Button variant="ghost" onClick={() => setIds((old) => old.filter((id) => id !== customer.id))}>
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
              <h2 className="font-semibold">Chọn mẫu tin nhắn Zalo cá nhân</h2>
              <p className="text-xs text-[var(--text-secondary)]">
                Không dùng OA/ZBS. Tin được gửi qua tài khoản Zalo cá nhân đang kết nối ZCAJS.
              </p>
            </div>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Tên chiến dịch</span>
              <input className={field} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ví dụ: Chăm sóc khách chưa chốt" />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Mẫu đã lưu</span>
              <select className={field} value={template} onChange={(e) => { setTemplate(e.target.value); requestId.current = null; }}>
                <option value="">Chọn mẫu Zalo cá nhân</option>
                {usableTemplates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            {canManageTemplates && (
              <Button variant="outline" type="button" onClick={() => setShowTemplateEditor((v) => !v)}>
                {showTemplateEditor ? "Đóng tạo mẫu" : "+ Tạo mẫu tin nhắn mới"}
              </Button>
            )}
            {showTemplateEditor && canManageTemplates && (
              <div className="space-y-3 rounded-lg border border-[var(--border-subtle)] p-4">
                <input className={field} maxLength={120} value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} placeholder="Tên mẫu" />
                <textarea className={field} rows={7} maxLength={2000} value={newTemplateContent} onChange={(e) => setNewTemplateContent(e.target.value)} placeholder="Nội dung tin nhắn" />
                <div className="flex flex-wrap gap-2">
                  {variables.map((variable) => (
                    <Button key={variable} type="button" size="xs" variant="outline" onClick={() => setNewTemplateContent((old) => `${old}${old ? " " : ""}{{${variable}}}`)}>
                      + {variableLabels[variable] || variable}
                    </Button>
                  ))}
                </div>
                <Button type="button" disabled={templateBusy} onClick={saveTemplate}>
                  {templateBusy ? "Đang lưu…" : "Lưu và dùng mẫu này"}
                </Button>
              </div>
            )}
            {templateMessage && <p role="status" className="text-sm">{templateMessage}</p>}
            {selectedTemplate && (
              <div className="rounded-lg border border-[var(--border-subtle)] p-4">
                <strong>{selectedTemplate.name}</strong>
                <p className="mt-2 whitespace-pre-wrap text-sm">{selectedTemplate.content}</p>
              </div>
            )}
            <label className="block space-y-1">
              <span className="text-sm font-medium">Tài khoản gửi</span>
              <select className={field} value={sender} onChange={(e) => setSender(e.target.value)}>
                <option value="">Chọn tài khoản Zalo cá nhân</option>
                {personalSenders.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{!s.connected || !s.verified ? " — chưa sẵn sàng" : ""}</option>
                ))}
              </select>
            </label>
            <p className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm">
              Nhịp gửi cố định: <strong>1 khách mỗi 5 phút</strong>. Hệ thống không gửi đồng thời nhiều khách.
            </p>
            {!ready && (
              <p role="status" className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm">
                Zalo cá nhân/ZCAJS chưa sẵn sàng. Kiểm tra kết nối worker trước khi gửi.
              </p>
            )}
          </>
        )}

        {step === 3 && preview && campaign && (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">Kiểm tra trước khi gửi</h2>
                <p className="text-sm">
                  Đã chọn {campaign.selected_count} · Có thể gửi {campaign.eligible_count} · Bị loại {campaign.selected_count - campaign.eligible_count}
                </p>
              </div>
              <Button variant="outline" disabled={contactBusy} onClick={() => void refreshContacts()}>
                {contactBusy ? "Đang đồng bộ…" : "Đồng bộ danh bạ Zalo"}
              </Button>
            </div>
            {contactMessage && <p role="status" className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm">{contactMessage}</p>}
            {preview.recipients.map((recipient) => {
              const missingIdentity = recipient.eligibility_status === "MISSING_IDENTITY" || recipient.eligibility_reason === "MISSING_IDENTITY";
              return (
                <div key={recipient.id} className="rounded border border-[var(--border-subtle)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <strong>{recipient.recipient_snapshot.name}</strong>
                      <p className="text-xs">
                        {reasonLabels[recipient.eligibility_status] || recipient.eligibility_status}
                        {recipient.eligibility_reason ? ` · ${reasonLabels[recipient.eligibility_reason] || recipient.eligibility_reason}` : ""}
                      </p>
                    </div>
                    {missingIdentity && (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={contactBusy}
                        onClick={() => void refreshContacts({
                          customerId: recipient.customer_id,
                          customerName: recipient.recipient_snapshot.name,
                        })}
                      >
                        Liên kết Zalo
                      </Button>
                    )}
                  </div>
                  {recipient.personalized_payload && <p className="mt-2 whitespace-pre-wrap text-sm">{recipient.personalized_payload.text}</p>}
                </div>
              );
            })}
          </>
        )}

        {step === 4 && campaign && (
          <>
            <div>
              <h2 className="font-semibold">Gửi tin nhắn qua Zalo cá nhân</h2>
              <p className="text-sm">{campaign.name} · {senderName || "Zalo cá nhân"}</p>
              <p className="text-sm">Có thể gửi {campaign.eligible_count}/{campaign.selected_count} khách hàng</p>
            </div>
            <div className="rounded-md bg-[var(--surface-secondary)] p-3 text-sm">
              <strong>Khoảng cách: 5 phút/khách.</strong> Với {campaign.eligible_count} khách, lượt cuối dự kiến bắt đầu sau khoảng {estimatedMinutes} phút kể từ lượt đầu.
            </div>
            <label className="block space-y-1">
              <span className="text-sm font-medium">Bắt đầu</span>
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="now">Bắt đầu ngay</option>
                <option value="schedule">Đặt giờ bắt đầu</option>
              </select>
            </label>
            {mode === "schedule" && (
              <input type="datetime-local" className={field} value={schedule} onChange={(e) => setSchedule(e.target.value)} />
            )}
            <Button disabled={busy || !canExecute || !ready || campaign.eligible_count === 0 || (mode === "schedule" && !schedule)} onClick={() => setModal(true)}>
              {mode === "schedule" ? "Đặt lịch gửi" : "Bắt đầu gửi"} cho {campaign.eligible_count} người
            </Button>
          </>
        )}
      </Card>

      <div className="flex flex-wrap gap-3">
        {step > 1 && <Button variant="outline" disabled={busy || templateBusy || contactBusy} onClick={() => setStep(step - 1)}>Quay lại</Button>}
        {step === 1 && <Button disabled={!ids.length} onClick={() => setStep(2)}>Tiếp tục: chọn mẫu tin nhắn</Button>}
        {step === 2 && <Button disabled={busy || templateBusy || !name.trim() || !template || !sender} onClick={prepare}>{busy ? "Đang kiểm tra…" : "Lưu bản nháp và kiểm tra"}</Button>}
        {step === 3 && <Button disabled={!campaign || campaign.eligible_count === 0 || contactBusy} onClick={() => setStep(4)}>Tiếp tục: gửi tin nhắn</Button>}
      </div>

      <Modal
        isOpen={modal}
        onClose={() => { if (!busy) setModal(false); }}
        title="Xác nhận gửi Zalo cá nhân"
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setModal(false)}>Quay lại</Button>
            <Button disabled={busy} onClick={confirm}>{mode === "schedule" ? "Đặt lịch" : "Bắt đầu gửi"}</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>{campaign?.eligible_count || 0} khách đủ điều kiện.</p>
          <p>Mỗi tin nhắn cách tin trước <strong>5 phút</strong>; không gửi đồng thời.</p>
          <p>Lượt cuối dự kiến bắt đầu sau khoảng {estimatedMinutes} phút kể từ lượt đầu.</p>
        </div>
      </Modal>

      <Modal
        isOpen={linkModal}
        onClose={() => {
          if (!contactBusy) {
            setLinkModal(false);
            setLinkTarget(null);
            setSelectedCandidate("");
          }
        }}
        title="Liên kết tài khoản Zalo"
        footer={
          <>
            <Button
              variant="outline"
              disabled={contactBusy}
              onClick={() => {
                setLinkModal(false);
                setLinkTarget(null);
                setSelectedCandidate("");
              }}
            >
              Hủy
            </Button>
            <Button disabled={contactBusy || !selectedCandidate || !linkTarget} onClick={() => void linkSelectedContact()}>
              Xác nhận liên kết
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p>
            Chọn đúng tài khoản Zalo của <strong>{linkTarget?.customerName || "khách hàng"}</strong>.
            Hệ thống không tự ghép theo tên để tránh gửi nhầm người.
          </p>
          {contactBusy && <p>Đang đồng bộ danh bạ Zalo cá nhân…</p>}
          {!contactBusy && contactCandidates.length === 0 && (
            <p>Chưa tìm thấy liên hệ Zalo nào chưa được gắn với Customer 360.</p>
          )}
          {contactCandidates.length > 0 && (
            <label className="block space-y-1">
              <span className="font-medium">Liên hệ Zalo chưa liên kết</span>
              <select className={field} value={selectedCandidate} onChange={(e) => setSelectedCandidate(e.target.value)}>
                <option value="">Chọn đúng người trên Zalo</option>
                {contactCandidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.display_name || "Liên hệ Zalo chưa có tên"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {contactMessage && <p role="status">{contactMessage}</p>}
        </div>
      </Modal>
    </div>
  );
}
