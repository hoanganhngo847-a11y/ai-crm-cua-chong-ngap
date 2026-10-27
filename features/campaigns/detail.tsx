"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { runCampaignCommand } from "../../app/actions/campaigns";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Modal } from "../../components/ui/modal";
import {
  reasonLabels,
  vietnamSchedule,
  type CampaignData,
  type Channel,
} from "./contracts";
import { CUSTOMER_STAGE_LABELS } from "../crm/types/customer.types";
function date(value: string | null) {
  return value
    ? new Date(value).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    : "—";
}
export function CampaignDetail({
  data,
  boss,
  canExecute,
  readiness,
}: {
  data: CampaignData;
  boss: boolean;
  canExecute: boolean;
  readiness: Record<Channel, boolean>;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [schedule, setSchedule] = useState("");
  const [onlyExcluded, setOnlyExcluded] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<{
    customerId: string;
    source: string;
    name: string;
  } | null>(null);
  const [restoreReason, setRestoreReason] = useState("");
  const c = data.campaign!;
  async function command(cmd: string, input: unknown = { id: c.id }) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await runCampaignCommand(cmd, input);
      setMessage(result.message);
      if (result.ok) {
        setConfirm(false);
        router.refresh();
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const terminal = [
    "COMPLETED",
    "FAILED",
    "PARTIALLY_FAILED",
    "CANCELLED",
  ].includes(c.status);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded border p-2 text-xs">{c.status}</span>
        <Button variant="outline" onClick={() => router.refresh()}>
          Cập nhật kết quả
        </Button>
        {["DRAFT", "READY"].includes(c.status) && (
          <Button disabled={busy} onClick={() => command("validate")}>
            Kiểm tra eligibility
          </Button>
        )}
        {c.status === "READY" && (
          <Button
            disabled={
              busy ||
              !canExecute ||
              !readiness[c.channel] ||
              c.eligible_count === 0
            }
            onClick={() => setConfirm(true)}
          >
            Xác nhận gửi {c.eligible_count} tin nhắn
          </Button>
        )}
        {boss && ["RUNNING", "SCHEDULED"].includes(c.status) && (
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => command("pause")}
          >
            Pause
          </Button>
        )}
        {boss && c.status === "PAUSED" && (
          <Button disabled={busy} onClick={() => command("resume")}>
            Resume
          </Button>
        )}
        {boss && !terminal && (
          <Button
            disabled={busy}
            variant="outline"
            onClick={() => command("cancel")}
          >
            Cancel các tin chưa gửi
          </Button>
        )}
      </div>
      {!readiness[c.channel] && (
        <p role="status">
          {c.channel === "FACEBOOK"
            ? "Facebook Messenger hiện chưa sẵn sàng cho gửi chiến dịch."
            : "Zalo OA/ZBS hiện chưa sẵn sàng cho gửi chiến dịch."}
        </p>
      )}
      <p role="status">{message}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {[
          ["Đã chọn", c.selected_count],
          ["Eligible", c.eligible_count],
          ["Đã gửi", c.sent_count],
          ["Delivered", c.delivered_count],
          ["Failed / Unknown", c.failed_count],
          ["Bỏ qua", c.skipped_count],
        ].map(([label, count]) => (
          <Card key={label} className="p-4">
            <p className="text-xs">{label}</p>
            <strong className="text-xl">{count}</strong>
          </Card>
        ))}
      </div>
      <progress
        aria-label="Tiến độ chiến dịch"
        className="w-full"
        max={c.selected_count || 1}
        value={c.sent_count + c.failed_count + c.skipped_count}
      />
      <Card className="space-y-2 p-5 text-sm">
        <p>
          Kênh: {c.channel} · Tài khoản:{" "}
          {data.senders.find((s) => s.id === c.sender_account_id)?.name || "—"}
        </p>
        <p>
          Đặt lịch: {date(c.scheduled_at)} · Bắt đầu: {date(c.started_at)} · Kết
          thúc: {date(c.finished_at)}
        </p>
        <p>Múi giờ: Asia/Ho_Chi_Minh</p>
        <h2 className="font-semibold">
          Mẫu đóng băng: {c.template_snapshot.name}
        </h2>
        <pre className="whitespace-pre-wrap">{c.template_snapshot.content}</pre>
        <p>Provider ID: {c.template_snapshot.provider_template_id || "—"}</p>
      </Card>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={onlyExcluded}
          onChange={(e) => setOnlyExcluded(e.target.checked)}
        />
        Chỉ xem người nhận bị loại
      </label>
      <div className="space-y-3">
        {data.recipients
          .filter((r) => !onlyExcluded || r.eligibility_status !== "ELIGIBLE")
          .map((r) => (
            <Card key={r.id} className="space-y-2 p-4 text-sm">
              <div className="flex flex-wrap justify-between gap-3">
                <Link
                  className="font-medium text-[var(--accent)]"
                  href={`/customers/${r.customer_id}/dossier`}
                >
                  {r.recipient_snapshot.name} ·{" "}
                  {r.recipient_snapshot.customer_code}
                </Link>
                <span>
                  {r.delivery_status} ·{" "}
                  {reasonLabels[r.eligibility_status] || r.eligibility_status}
                </span>
              </div>
              <p className="text-xs">
                {r.recipient_snapshot.channels.join(", ")} ·{" "}
                {r.recipient_snapshot.assigned_sale_name || "Chưa phân công"} ·{" "}
                {CUSTOMER_STAGE_LABELS[r.recipient_snapshot.stage] || r.recipient_snapshot.stage}
              </p>
              <p>
                {reasonLabels[r.eligibility_reason || ""] ||
                  r.eligibility_reason}
              </p>
              {r.personalized_payload && (
                <p className="whitespace-pre-wrap">
                  {r.personalized_payload.text}
                </p>
              )}
              <p className="text-xs">
                Lần gửi: {r.attempt_count} · Provider message ID:{" "}
                {r.provider_message_id || "—"} · Mã lỗi:{" "}
                {r.provider_error_code || "—"}
              </p>
              {r.provider_error_message_sanitized && (
                <p>{r.provider_error_message_sanitized}</p>
              )}
              <p className="text-xs">
                Gửi: {date(r.sent_at)} · Delivered: {date(r.delivered_at)} ·
                Read: {date(r.read_at)}
              </p>
              {r.suppression ? (
                <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-xs text-amber-900 dark:text-amber-200">
                  <p className="font-semibold">Đã chặn nhận tin ({r.suppression.status})</p>
                  <p className="mt-0.5">
                    Nguồn: {r.suppression.source === "CUSTOMER_OPT_OUT" ? "Khách hàng yêu cầu dừng nhận tin" : r.suppression.source === "BOSS_ADMIN" ? "Quản trị viên chặn" : r.suppression.source}
                    {r.suppression.created_at && ` · ${date(r.suppression.created_at)}`}
                  </p>
                  {boss && (
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-2 text-xs"
                      disabled={busy}
                      onClick={() => {
                        setRestoreReason("");
                        setRestoreTarget({
                          customerId: r.customer_id,
                          source: r.suppression!.source,
                          name: r.recipient_snapshot.name,
                        });
                      }}
                    >
                      Khôi phục quyền nhận tin
                    </Button>
                  )}
                </div>
              ) : boss && (
                <form
                  action={async (f) => {
                    await command("suppress", {
                      customer_id: r.customer_id,
                      channel: c.channel,
                      status: f.get("status"),
                    });
                  }}
                  className="flex flex-wrap gap-2"
                >
                  <select
                    aria-label={`Chặn liên hệ ${r.recipient_snapshot.name}`}
                    name="status"
                    className="rounded border p-2"
                  >
                    <option value="DO_NOT_MESSAGE">DO_NOT_MESSAGE</option>
                    <option value="UNSUBSCRIBED">UNSUBSCRIBED</option>
                    <option value="BLOCKED">BLOCKED</option>
                  </select>
                  <Button type="submit" disabled={busy} variant="outline">
                    Chặn khách hàng trên kênh này
                  </Button>
                </form>
              )}
            </Card>
          ))}
      </div>
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Nhật ký chiến dịch</h2>
        {data.audit.map((e, i) => (
          <p key={i} className="py-1 text-xs">
            {date(e.created_at)} · {e.event} · {e.actor_user_id || "Worker"}
          </p>
        ))}
      </Card>
      <Modal
        isOpen={confirm}
        onClose={() => {
          if (!busy) setConfirm(false);
        }}
        title="Xác nhận gửi chiến dịch"
        footer={
          <>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => setConfirm(false)}
            >
              Quay lại
            </Button>
            <Button
              disabled={busy || !readiness[c.channel]}
              onClick={() => {
                try {
                  void command("confirm", {
                    id: c.id,
                    expected_version: c.validation_version,
                    expected_eligible: c.eligible_count,
                    scheduled_at: schedule ? vietnamSchedule(schedule) : null,
                  });
                } catch {
                  setMessage("Thời gian không hợp lệ.");
                }
              }}
            >
              {schedule ? "Đặt lịch" : "Gửi"} {c.eligible_count} tin nhắn
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p>
            {c.channel} ·{" "}
            {data.senders.find((s) => s.id === c.sender_account_id)?.name} ·{" "}
            {c.template_snapshot.name}
          </p>
          <p>
            Đã chọn {c.selected_count} · Có thể gửi {c.eligible_count} · Bị loại{" "}
            {c.selected_count - c.eligible_count}
          </p>
          <label className="block">
            Đặt lịch tại Việt Nam (để trống để gửi ngay)
            <input
              className="mt-2 w-full rounded border p-2"
              type="datetime-local"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </label>
          <p>Bạn chuẩn bị gửi {c.eligible_count} tin nhắn.</p>
        </div>
      </Modal>
      <Modal
        isOpen={Boolean(restoreTarget)}
        onClose={() => {
          if (!busy) setRestoreTarget(null);
        }}
        title="Khôi phục quyền nhận tin"
        footer={
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRestoreTarget(null)}
            >
              Hủy
            </Button>
            <Button
              disabled={
                busy ||
                (restoreTarget?.source === "CUSTOMER_OPT_OUT" &&
                  restoreReason.trim().length < 3)
              }
              onClick={async () => {
                if (!restoreTarget) return;
                await command("unsuppress", {
                  customer_id: restoreTarget.customerId,
                  channel: c.channel,
                  reason: restoreReason.trim() || undefined,
                });
                setRestoreTarget(null);
                setRestoreReason("");
              }}
            >
              Xác nhận khôi phục
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            Bạn đang chuẩn bị khôi phục quyền nhận tin cho khách hàng{" "}
            <strong>{restoreTarget?.name}</strong> trên kênh{" "}
            <strong>{c.channel}</strong>.
          </p>
          {restoreTarget?.source === "CUSTOMER_OPT_OUT" && (
            <div className="space-y-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-900 dark:text-amber-200">
              <p className="font-semibold">
                Khách hàng đã chủ động yêu cầu dừng nhận tin (CUSTOMER_OPT_OUT).
              </p>
              <p>
                Để khôi phục, bạn phải cung cấp lý do xác đáng (ví dụ: khách hàng
                đã xác nhận đồng ý nhận tin trở lại qua điện thoại / kênh khác).
              </p>
              <label className="block font-medium">
                Lý do khôi phục (bắt buộc, tối thiểu 3 ký tự):
                <input
                  aria-label="Lý do khôi phục"
                  type="text"
                  className="mt-1 w-full rounded border p-2 text-sm text-[var(--text-primary)] bg-[var(--surface-primary)]"
                  placeholder="Ví dụ: Khách đồng ý qua cuộc gọi tư vấn ngày 24/10"
                  value={restoreReason}
                  onChange={(e) => setRestoreReason(e.target.value)}
                />
              </label>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
