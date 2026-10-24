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

function TemplateEditor({
  editing,
  data,
  busy,
  message,
  onSave,
  onCancel,
}: {
  editing: Template | null;
  data: CampaignData;
  busy: boolean;
  message: string;
  onSave: (form: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const [channel, setChannel] = useState<Channel>(editing?.channel || "FACEBOOK");
  const [templateType, setTemplateType] = useState(
    editing?.template_type || "MESSENGER_RESPONSE",
  );
  const [content, setContent] = useState(editing?.content || "");
  const availableSenders = data.senders.filter((s) => s.channel === channel);

  return (
    <Card className="p-5">
      <form action={onSave} className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">
            {editing ? "Chỉnh sửa mẫu" : "Tạo mẫu tin nhắn mới"}
          </h2>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Viết nội dung theo ý bạn. Mẫu được lưu trong CRM trước; trạng thái gửi
            thật được kiểm tra riêng.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Tên mẫu</span>
          <input
            name="name"
            required
            maxLength={120}
            defaultValue={editing?.name}
            placeholder="Ví dụ: Chăm sóc khách sau báo giá"
            className={field}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Kênh</span>
          <select
            aria-label="Kênh"
            name="channel"
            value={channel}
            onChange={(e) => {
              const next = e.target.value as Channel;
              setChannel(next);
              setTemplateType(
                next === "FACEBOOK" ? "MESSENGER_RESPONSE" : "OA_SERVICE",
              );
            }}
            className={field}
          >
            <option value="FACEBOOK">Facebook Messenger</option>
            <option value="ZALO_OA">Zalo Official Account / ZBS</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium">Nội dung tin nhắn</span>
          <textarea
            name="content"
            required
            maxLength={2000}
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Nhập nội dung bạn muốn gửi cho khách hàng..."
            className={field}
          />
        </label>

        <div className="space-y-2">
          <p className="text-xs font-medium">Chèn biến tự động</p>
          <div className="flex flex-wrap gap-2">
            {variables.map((variable) => (
              <Button
                key={variable}
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  setContent((old) => `${old}${old ? " " : ""}{{${variable}}}`)
                }
              >
                + {variableLabels[variable] || variable}
              </Button>
            ))}
          </div>
          <p className="text-xs text-[var(--text-secondary)]">
            Ví dụ: “Chào {"{{customer_name}}"}, bên em gửi lại thông tin cho mã
            {" {{customer_code}}"}.”
          </p>
        </div>

        <details className="rounded-md border border-[var(--border-subtle)] p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Cài đặt nâng cao / provider
          </summary>
          <div className="mt-4 space-y-4">
            <label className="block space-y-1">
              <span className="text-sm">Tài khoản gửi cố định (không bắt buộc)</span>
              <select
                aria-label="Tài khoản gửi"
                name="sender"
                defaultValue={editing?.sender_account_id || ""}
                className={field}
              >
                <option value="">Mọi tài khoản cùng kênh của công ty</option>
                {availableSenders.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-sm">Loại mẫu</span>
              <select
                aria-label="Loại mẫu"
                name="type"
                value={templateType}
                onChange={(e) => setTemplateType(e.target.value)}
                className={field}
              >
                {channel === "FACEBOOK" ? (
                  <option value="MESSENGER_RESPONSE">Messenger response</option>
                ) : (
                  <>
                    <option value="OA_SERVICE">Zalo OA service message</option>
                    <option value="ZBS_TEMPLATE">ZBS Template Message</option>
                  </>
                )}
              </select>
            </label>

            {templateType === "ZBS_TEMPLATE" && (
              <label className="block space-y-1">
                <span className="text-sm">ZBS Provider Template ID</span>
                <input
                  name="provider"
                  maxLength={150}
                  required
                  defaultValue={editing?.provider_template_id || ""}
                  placeholder="ID do Zalo/ZBS cấp sau khi duyệt"
                  className={field}
                />
              </label>
            )}
            {templateType !== "ZBS_TEMPLATE" && (
              <input type="hidden" name="provider" value="" />
            )}

            <label className="block space-y-1">
              <span className="text-sm">Ánh xạ tham số provider (JSON)</span>
              <textarea
                name="mapping"
                rows={3}
                defaultValue={JSON.stringify(editing?.parameter_mapping || {})}
                className={field}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm">Trạng thái trong CRM</span>
              <select
                aria-label="Trạng thái"
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
                <option value="DRAFT">Bản nháp</option>
                <option value="ACTIVE">Sẵn sàng dùng trong CRM</option>
                <option value="PROVIDER_PENDING">Đang chờ provider duyệt</option>
                <option value="DISABLED">Tắt mẫu</option>
              </select>
            </label>
          </div>
        </details>

        {channel === "ZALO_OA" && (
          <p className="rounded-md bg-[var(--surface-secondary)] p-3 text-xs">
            Bạn có thể tự soạn và lưu mẫu Zalo trong CRM. Việc gửi thật qua OA/ZBS
            vẫn chỉ mở khi tài khoản chính thức, consent/evidence và trạng thái
            provider đáp ứng đầy đủ chính sách.
          </p>
        )}

        <p role="status" className="text-sm">
          {message}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Đang lưu…" : "Lưu mẫu tin nhắn"}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Hủy sửa / Tạo mẫu mới
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

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
        "Mẫu chưa hợp lệ. Kiểm tra nội dung, biến tự động và thông tin provider nếu dùng ZBS.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Mẫu đã lưu</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              {data.templates.length} mẫu trong thư viện của công ty.
            </p>
          </div>
          {boss && editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              + Mẫu mới
            </Button>
          )}
        </div>
        {data.templates.length === 0 && (
          <Card className="p-5">
            Chưa có mẫu nào. Tạo mẫu đầu tiên ở khung bên cạnh.
          </Card>
        )}
        {data.templates.map((t) => (
          <Card key={t.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{t.name}</h3>
              <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-1 text-xs">
                {t.channel} · {t.status}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{t.content}</p>
            <p className="text-xs text-[var(--text-secondary)]">
              {t.template_type}
              {t.provider_template_id ? ` · Provider ID: ${t.provider_template_id}` : ""}
            </p>
            {boss && (
              <Button variant="outline" size="sm" onClick={() => setEditing(t)}>
                Chỉnh sửa mẫu
              </Button>
            )}
          </Card>
        ))}
      </div>
      {boss ? (
        <TemplateEditor
          key={editing?.id || "new"}
          editing={editing}
          data={data}
          busy={busy}
          message={message}
          onSave={save}
          onCancel={() => {
            setEditing(null);
            setMessage("");
          }}
        />
      ) : (
        <Card className="p-5 text-sm text-[var(--text-secondary)]">
          Bạn có thể dùng các mẫu đã được quản trị viên duyệt. Chỉ BOSS_ADMIN có
          quyền tạo hoặc thay đổi mẫu tin nhắn của công ty.
        </Card>
      )}
    </div>
  );
}
