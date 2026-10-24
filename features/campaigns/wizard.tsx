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
  vietnamSchedule,
  type CampaignData,
  type Channel,
} from "./contracts";
const field =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-2 text-sm";
export function CampaignWizard({
  data,
  readiness,
  canExecute,
}: {
  data: CampaignData;
  readiness: Record<Channel, boolean>;
  canExecute: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [ids, setIds] = useState(data.customers.map((c) => c.id));
  const [channel, setChannel] = useState<Channel>("FACEBOOK");
  const [sender, setSender] = useState("");
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [mode, setMode] = useState("now");
  const [preview, setPreview] = useState<CampaignData | null>(null);
  const [modal, setModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const c = preview?.campaign;
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
      setStep(4);
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
  const picked = data.templates.filter(
    (t) =>
      t.channel === channel &&
      (!t.sender_account_id || t.sender_account_id === sender) &&
      ["ACTIVE", "PROVIDER_APPROVED"].includes(t.status),
  );
  const selectedTemplate = picked.find((t) => t.id === template);
  const senderName = data.senders.find((s) => s.id === sender)?.name;
  return (
    <div className="space-y-4">
      <ol className="grid grid-cols-5 gap-2 text-xs">
        {["Người nhận", "Kênh gửi", "Mẫu tin", "Kiểm tra", "Xác nhận"].map(
          (label, i) => (
            <li
              key={label}
              aria-current={step === i + 1 ? "step" : undefined}
              className={`rounded-lg border p-3 ${step === i + 1 ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border-subtle)]"}`}
            >
              {i + 1}. {label}
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
            <h2 className="font-semibold">{ids.length} người nhận</h2>
            {data.customers
              .filter((c) => ids.includes(c.id))
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
              <Link href="/customers/dossier">
                Chọn khách hàng trong Customer 360
              </Link>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <label className="block">
              Kênh gửi
              <select aria-label="Kênh gửi"
                className={field}
                value={channel}
                onChange={(e) => {
                  requestId.current = null;
                  setChannel(e.target.value as Channel);
                  setSender("");
                  setTemplate("");
                }}
              >
                <option value="FACEBOOK">Facebook Messenger</option>
                <option value="ZALO_OA">Zalo Official Account / ZBS</option>
              </select>
            </label>
            <label className="block">
              Tài khoản gửi
              <select aria-label="Tài khoản gửi"
                className={field}
                value={sender}
                onChange={(e) => {
                  requestId.current = null;
                  setSender(e.target.value);
                  setTemplate("");
                }}
              >
                <option value="">Chọn Page / OA</option>
                {data.senders
                  .filter((s) => s.channel === channel)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {!s.connected || !s.verified ? " — chưa sẵn sàng" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {!readiness[channel] && (
              <p role="status">
                {channel === "FACEBOOK"
                  ? "Facebook Messenger hiện chưa sẵn sàng cho gửi chiến dịch."
                  : "Zalo OA/ZBS hiện chưa sẵn sàng cho gửi chiến dịch."}{" "}
                Bạn có thể tạo bản nháp và kiểm tra người nhận.
              </p>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <label className="block">
              Tên chiến dịch
              <input
                maxLength={120}
                className={field}
                value={name}
                onChange={(e) => {
                  requestId.current = null;
                  setName(e.target.value);
                }}
              />
            </label>
            <label className="block">
              Mẫu đã duyệt
              <select aria-label="Mẫu đã duyệt"
                className={field}
                value={template}
                onChange={(e) => {
                  requestId.current = null;
                  setTemplate(e.target.value);
                }}
              >
                <option value="">Chọn mẫu</option>
                {picked.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.template_type}
                  </option>
                ))}
              </select>
            </label>
            {selectedTemplate && (
              <pre className="whitespace-pre-wrap rounded bg-[var(--surface-secondary)] p-3 text-sm">
                {selectedTemplate.content}
              </pre>
            )}
            {!picked.length && (
              <Link href="/campaigns/templates">
                Chưa có mẫu phù hợp. Mở thư viện mẫu.
              </Link>
            )}
          </>
        )}
        {step === 4 && preview && c && (
          <>
            <h2 className="font-semibold">
              Đã chọn {c.selected_count} · Có thể gửi {c.eligible_count} · Bị
              loại {c.selected_count - c.eligible_count}
            </h2>
            <div className="flex flex-wrap gap-4 text-sm">
              {Object.entries(
                preview.recipients.reduce<Record<string, number>>((acc, r) => {
                  acc[r.eligibility_status] =
                    (acc[r.eligibility_status] || 0) + 1;
                  return acc;
                }, {}),
              ).map(([key, count]) => (
                <span key={key}>
                  {reasonLabels[key] || key}: {count}
                </span>
              ))}
            </div>
            <p className="text-xs">
              Bản xem trước đã đóng băng. Điều kiện nhận tin sẽ được kiểm tra
              lại trước khi gửi. Khách hàng bị loại không thể được ghi đè.
            </p>
            {preview.recipients.map((r) => (
              <div
                key={r.id}
                className="rounded border border-[var(--border-subtle)] p-3"
              >
                <strong>{r.recipient_snapshot.name}</strong>
                <p className="text-xs">
                  {reasonLabels[r.eligibility_status]} ·{" "}
                  {r.eligibility_reason
                    ? reasonLabels[r.eligibility_reason] || r.eligibility_reason
                    : ""}
                </p>
                {r.personalized_payload && (
                  <p className="mt-2 whitespace-pre-wrap text-sm">
                    {r.personalized_payload.text}
                  </p>
                )}
              </div>
            ))}
            <p className="text-xs">
              Hiển thị toàn bộ bản xem trước, gồm ít nhất 3 người nhận khi có đủ
              3 người đủ điều kiện.
            </p>
          </>
        )}
        {step === 5 && c && (
          <>
            <h2 className="font-semibold">{c.name}</h2>
            <p>
              {channel} · {senderName} · {c.template_snapshot.name}
            </p>
            <p>
              Đã chọn {c.selected_count} · Có thể gửi {c.eligible_count} · Bị
              loại {c.selected_count - c.eligible_count}
            </p>
            <label className="block">
              Thời điểm
              <select aria-label="Thời điểm"
                className={field}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="now">Gửi ngay</option>
                <option value="schedule">Đặt lịch</option>
              </select>
            </label>
            {mode === "schedule" && (
              <label className="block">
                Thời gian tại Việt Nam (Asia/Ho_Chi_Minh)
                <input
                  type="datetime-local"
                  className={field}
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                />
              </label>
            )}
            {!canExecute && (
              <p>
                SALE có thể tạo và xem trước. Quyền thực thi chưa được quản trị
                viên bật.
              </p>
            )}
            {!readiness[channel] && (
              <p role="status">
                {channel === "FACEBOOK"
                  ? "Facebook Messenger hiện chưa sẵn sàng cho gửi chiến dịch."
                  : "Zalo OA/ZBS hiện chưa sẵn sàng cho gửi chiến dịch."}
              </p>
            )}
            <Button
              disabled={
                busy ||
                !canExecute ||
                !readiness[channel] ||
                c.eligible_count === 0 ||
                (mode === "schedule" && !schedule)
              }
              onClick={() => setModal(true)}
            >
              Xác nhận {mode === "schedule" ? "đặt lịch" : "gửi"}{" "}
              {c.eligible_count} tin nhắn
            </Button>
            <Link
              className="ml-3 text-sm text-[var(--accent)]"
              href={`/campaigns/${c.id}`}
            >
              Lưu và xem bản nháp
            </Link>
          </>
        )}
      </Card>
      <div className="flex gap-3">
        {step > 1 && (
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => {
              if (step === 4) {
                requestId.current = null;
                setPreview(null);
              }
              setStep(step - 1);
            }}
          >
            Quay lại
          </Button>
        )}
        {step < 3 && (
          <Button
            disabled={
              busy || (step === 1 && !ids.length) || (step === 2 && !sender)
            }
            onClick={() => setStep(step + 1)}
          >
            Tiếp tục
          </Button>
        )}
        {step === 3 && (
          <Button
            disabled={busy || !name.trim() || !template}
            onClick={prepare}
          >
            {busy ? "Đang kiểm tra…" : "Lưu bản nháp và kiểm tra"}
          </Button>
        )}
        {step === 4 && (
          <Button onClick={() => setStep(5)}>Tiếp tục xác nhận</Button>
        )}
        {step >= 4 && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              requestId.current = null;
              setPreview(null);
              setStep(1);
            }}
          >
            Tạo bản nháp mới với lựa chọn khác
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
            Kênh: {channel} · Tài khoản: {senderName} · Mẫu:{" "}
            {c?.template_snapshot.name}
          </p>
          <p>
            Đã chọn: {c?.selected_count} · Có thể gửi: {c?.eligible_count} · Bị
            loại: {(c?.selected_count || 0) - (c?.eligible_count || 0)}
          </p>
          <p>
            Bạn chuẩn bị {mode === "schedule" ? "đặt lịch" : "gửi"}{" "}
            {c?.eligible_count} tin nhắn.
          </p>
        </div>
      </Modal>
    </div>
  );
}
