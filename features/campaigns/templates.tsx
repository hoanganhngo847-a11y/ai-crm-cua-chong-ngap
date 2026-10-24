"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runCampaignCommand } from "../../app/actions/campaigns";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import {
  templateVariables,
  variables,
  type CampaignData,
  type Template,
} from "./contracts";
const field =
  "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-2 text-sm";
export function TemplateLibrary({
  data,
  boss,
}: {
  data: CampaignData;
  boss: boolean;
}) {
  const router = useRouter();
  const lock = useRef(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(form: FormData) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const content = String(form.get("content") || "");
      templateVariables(content);
      const result = await runCampaignCommand("template", {
        ...(editing ? { id: editing.id } : {}),
        name: form.get("name"),
        channel: form.get("channel"),
        sender_account_id: form.get("sender") || null,
        provider_template_id: form.get("provider") || null,
        template_type: form.get("type"),
        parameter_mapping: JSON.parse(String(form.get("mapping") || "{}")),
        content,
        status: form.get("status"),
      });
      setMessage(result.message);
      if (result.ok) {
        setEditing(null);
        router.refresh();
      }
    } catch {
      setMessage(
        "Mẫu không hợp lệ. Chỉ dùng biến cho phép và provider template ID đã được cấp.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <div className="space-y-3">
        {data.templates.length === 0 && (
          <Card className="p-5">Chưa có mẫu tin nhắn.</Card>
        )}
        {data.templates.map((t) => (
          <Card key={t.id} className="space-y-3 p-4">
            <h2 className="font-semibold">
              {t.name}{" "}
              <span className="text-xs font-normal">
                {t.channel} · {t.status}
              </span>
            </h2>
            <pre className="whitespace-pre-wrap text-sm">{t.content}</pre>
            <p className="text-xs">
              {t.template_type} · Provider ID: {t.provider_template_id || "—"}
            </p>
            {boss && (
              <Button variant="outline" onClick={() => setEditing(t)}>
                Sửa / duyệt / tắt mẫu
              </Button>
            )}
          </Card>
        ))}
      </div>
      {boss && (
        <Card className="p-5">
          <form key={editing?.id || "new"} action={save} className="space-y-4">
            <h2 className="font-semibold">
              {editing ? "Chỉnh sửa mẫu" : "Mẫu mới"}
            </h2>
            <label className="block">
              Tên
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={editing?.name}
                className={field}
              />
            </label>
            <label className="block">
              Kênh
              <select aria-label="Kênh"
                name="channel"
                defaultValue={editing?.channel || "FACEBOOK"}
                className={field}
              >
                <option value="FACEBOOK">Facebook Messenger</option>
                <option value="ZALO_OA">Zalo OA / ZBS</option>
              </select>
            </label>
            <label className="block">
              Tài khoản gửi
              <select aria-label="Tài khoản gửi"
                name="sender"
                defaultValue={editing?.sender_account_id || ""}
                className={field}
              >
                <option value="">Mọi tài khoản cùng kênh của công ty</option>
                {data.senders.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name} · {s.channel}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Loại mẫu
              <select aria-label="Loại mẫu"
                name="type"
                defaultValue={editing?.template_type || "MESSENGER_RESPONSE"}
                className={field}
              >
                <option value="MESSENGER_RESPONSE">
                  Messenger trong cửa sổ cho phép
                </option>
                <option value="OA_SERVICE">OA theo điều kiện dịch vụ</option>
                <option value="ZBS_TEMPLATE">ZBS Template Message</option>
              </select>
            </label>
            <label className="block">
              Provider template ID
              <input
                name="provider"
                maxLength={150}
                defaultValue={editing?.provider_template_id || ""}
                className={field}
              />
            </label>
            <label className="block">
              Ánh xạ tham số provider (JSON)
              <textarea
                name="mapping"
                rows={3}
                defaultValue={JSON.stringify(editing?.parameter_mapping || {})}
                className={field}
              />
            </label>
            <p className="text-xs">
              Ví dụ: {'{"name":"customer_name","code":"customer_code"}'}. Chỉ
              dùng tên biến trong danh sách cho phép.
            </p>
            <label className="block">
              Nội dung
              <textarea
                name="content"
                required
                maxLength={2000}
                rows={6}
                defaultValue={editing?.content}
                className={field}
              />
            </label>
            <p className="text-xs">
              Biến cho phép: {variables.map((v) => `{{${v}}}`).join(", ")}. Giá
              trị thiếu sẽ bị chặn.
            </p>
            <label className="block">
              Trạng thái
              <select aria-label="Trạng thái"
                name="status"
                defaultValue={
                  editing &&
                  ["DRAFT", "ACTIVE", "DISABLED", "PROVIDER_PENDING"].includes(
                    editing.status,
                  )
                    ? editing.status
                    : "DRAFT"
                }
                className={field}
              >
                <option value="DRAFT">DRAFT</option>
                <option value="ACTIVE">ACTIVE — BOSS duyệt mẫu CRM</option>
                <option value="DISABLED">DISABLED</option>
                <option value="PROVIDER_PENDING">PROVIDER_PENDING</option>
              </select>
            </label>
            <p className="text-xs">
              ZBS chỉ được gửi sau khi provider xác minh phê duyệt và thông số
              mẫu. Chỉnh sửa nội dung làm mất phê duyệt provider. Mẫu trong
              chiến dịch đã tạo được giữ nguyên.
            </p>
            <p role="status">{message}</p>
            <Button type="submit" disabled={busy}>
              {busy ? "Đang lưu…" : "Lưu mẫu"}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Mẫu mới
              </Button>
            )}
          </form>
        </Card>
      )}
    </div>
  );
}
