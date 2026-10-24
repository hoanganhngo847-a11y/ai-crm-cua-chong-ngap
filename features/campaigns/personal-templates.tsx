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

const variableLabels: Record<string, string> = {
  customer_name: "Tên khách hàng",
  customer_code: "Mã khách hàng",
  assigned_sale_name: "Sale phụ trách",
  company_name: "Tên công ty",
};

export function PersonalZaloTemplateLibrary({
  data,
  boss,
}: {
  data: CampaignData;
  boss: boolean;
}) {
  const router = useRouter();
  const lock = useRef(false);
  const personal = data.templates.filter((t) => t.channel === "ZALO_PERSONAL");
  const [editing, setEditing] = useState<Template | null>(null);
  const [content, setContent] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function beginEdit(template: Template | null) {
    setEditing(template);
    setContent(template?.content || "");
    setMessage("");
  }

  async function save(form: FormData) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      templateVariables(content);
      const result = await runCampaignCommand("template", {
        ...(editing ? { id: editing.id } : {}),
        name: String(form.get("name") || "").trim(),
        channel: "ZALO_PERSONAL",
        sender_account_id: null,
        provider_template_id: null,
        template_type: "ZALO_PERSONAL_TEXT",
        parameter_mapping: {},
        content,
        status: String(form.get("status") || "ACTIVE"),
      });
      setMessage(result.message);
      if (result.ok) {
        setEditing(null);
        setContent("");
        router.refresh();
      }
    } catch {
      setMessage("Mẫu chưa hợp lệ. Kiểm tra nội dung và biến tự động.");
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
            <h2 className="font-semibold">Mẫu Zalo cá nhân đã lưu</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              {personal.length} mẫu. Không dùng Zalo OA/ZBS trong chiến dịch này.
            </p>
          </div>
          {boss && (
            <Button variant="outline" size="sm" onClick={() => beginEdit(null)}>
              + Mẫu mới
            </Button>
          )}
        </div>

        {personal.length === 0 && (
          <Card className="p-5 text-sm">
            Chưa có mẫu Zalo cá nhân. Tạo mẫu ở khung bên cạnh.
          </Card>
        )}

        {personal.map((template) => (
          <Card key={template.id} className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{template.name}</h3>
              <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-1 text-xs">
                Zalo cá nhân · {template.status}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{template.content}</p>
            {boss && (
              <Button variant="outline" size="sm" onClick={() => beginEdit(template)}>
                Chỉnh sửa mẫu
              </Button>
            )}
          </Card>
        ))}
      </div>

      {boss ? (
        <Card className="p-5">
          <form action={save} className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">
                {editing ? "Chỉnh sửa mẫu Zalo cá nhân" : "Tạo mẫu Zalo cá nhân"}
              </h2>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                Mẫu này dùng cho tài khoản Zalo cá nhân đang kết nối ZCAJS.
              </p>
            </div>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Tên mẫu</span>
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={editing?.name || ""}
                className={field}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Nội dung</span>
              <textarea
                required
                rows={8}
                maxLength={2000}
                className={field}
                value={content}
                onChange={(e) => setContent(e.target.value)}
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
                    setContent((old) => `${old}${old ? " " : ""}{{${variable}}}`)
                  }
                >
                  + {variableLabels[variable] || variable}
                </Button>
              ))}
            </div>

            <label className="block space-y-1">
              <span className="text-sm font-medium">Trạng thái</span>
              <select
                name="status"
                className={field}
                defaultValue={editing?.status === "DISABLED" ? "DISABLED" : "ACTIVE"}
              >
                <option value="ACTIVE">Sẵn sàng dùng</option>
                <option value="DRAFT">Bản nháp</option>
                <option value="DISABLED">Tắt mẫu</option>
              </select>
            </label>

            <p role="status" className="text-sm">{message}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Đang lưu…" : "Lưu mẫu"}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={() => beginEdit(null)}>
                  Hủy sửa
                </Button>
              )}
            </div>
          </form>
        </Card>
      ) : (
        <Card className="p-5 text-sm text-[var(--text-secondary)]">
          Chỉ BOSS_ADMIN có quyền tạo hoặc chỉnh sửa mẫu Zalo cá nhân.
        </Card>
      )}
    </div>
  );
}
