'use client';

import { useActionState } from 'react';
import {
  requestDossierRefresh,
  saveDossierNote,
  saveDossierProfile,
  linkDossierEmail,
} from '../../app/actions/customer-dossier';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { Sparkles, Plus, Save, UserCheck, Mail } from 'lucide-react';

const initial = { ok: false, message: '' };

export function DossierProfileForm({
  customerId,
  profile,
  owners,
}: {
  customerId: string;
  profile: {
    address: string | null;
    special_notes: string | null;
    birth_year: number | null;
    assigned_sale_id: string | null;
    assigned_sale_name?: string | null;
    sale_notes?: string | null;
    marketing_notes?: string | null;
    ai_notes?: string | null;
  } | null;
  owners: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(saveDossierProfile, initial);
  const [emailState, emailAction, emailPending] = useActionState(linkDossierEmail, initial);

  const inputStyle =
    'mt-1 w-full h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]';

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-[var(--accent)]" />
          <span>Cập nhật hồ sơ &amp; Thông tin liên hệ</span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">
        <form action={action} className="grid gap-4 text-xs sm:grid-cols-2">
          <input type="hidden" name="customerId" value={customerId} />

          <div className="flex flex-col gap-1">
            <label className="font-medium text-[var(--text-secondary)]">Địa chỉ lắp đặt / Khảo sát</label>
            <input
              name="address"
              defaultValue={profile?.address || ''}
              maxLength={1000}
              placeholder="Số nhà, tên đường, quận/huyện, tỉnh/thành..."
              className={inputStyle}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="font-medium text-[var(--text-secondary)]">Năm sinh</label>
            <input
              type="number"
              name="birthYear"
              min={1900}
              max={2100}
              defaultValue={profile?.birth_year ?? ''}
              placeholder="VD: 1985"
              className={inputStyle}
            />
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="font-medium text-[var(--text-secondary)]">Phân công cho Sale</label>
            <input
              name="assignedSaleName"
              list="owners-list"
              defaultValue={profile?.assigned_sale_name || owners.find((o) => o.id === profile?.assigned_sale_id)?.name || ''}
              maxLength={200}
              placeholder="Nhập tên sale hoặc chọn từ danh sách gợi ý..."
              className={inputStyle}
            />
            <datalist id="owners-list">
              {owners.map((o) => (
                <option key={o.id} value={o.name} />
              ))}
            </datalist>
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="font-medium text-[var(--text-secondary)]">Ghi chú của Sale</label>
            <textarea
              name="saleNotes"
              defaultValue={profile?.sale_notes || profile?.special_notes || ''}
              maxLength={4000}
              rows={2}
              placeholder="Ghi chú riêng của sale về tình trạng tư vấn, yêu cầu khách hàng..."
              className="mt-1 w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="font-medium text-[var(--text-secondary)]">Ghi chú của Marketing</label>
            <textarea
              name="marketingNotes"
              defaultValue={profile?.marketing_notes || ''}
              maxLength={4000}
              rows={2}
              placeholder="Nguồn chiến dịch, đối tượng mục tiêu, ghi chú từ marketing..."
              className="mt-1 w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className="font-medium text-[var(--text-secondary)]">Ghi chú của AI</label>
            <textarea
              name="aiNotes"
              defaultValue={profile?.ai_notes || ''}
              maxLength={4000}
              rows={2}
              placeholder="Ghi chú phân tích AI, đặc điểm khách hàng hoặc tóm tắt nhu cầu..."
              className="mt-1 w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="sm:col-span-2 flex items-center justify-between pt-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={pending}
              leftIcon={<Save className="w-3.5 h-3.5" />}
            >
              Lưu hồ sơ
            </Button>
            {state.message && (
              <p aria-live="polite" className="text-xs text-[var(--text-secondary)]">
                {state.message}
              </p>
            )}
          </div>
        </form>

        {/* Email Link Form */}
        <div className="pt-4 border-t border-[var(--border-subtle)]">
          <h4 className="text-xs font-semibold text-[var(--text-primary)] mb-2 flex items-center gap-1.5">
            <Mail className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <span>Liên kết địa chỉ Email mới</span>
          </h4>
          <form
            action={emailAction}
            className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
          >
            <input type="hidden" name="customerId" value={customerId} />
            <input
              type="email"
              name="email"
              maxLength={254}
              required
              placeholder="nhap-email-khach-hang@gmail.com"
              className="flex-1 h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              isLoading={emailPending}
              leftIcon={<Plus className="w-3.5 h-3.5" />}
            >
              Liên kết Email
            </Button>
          </form>
          {emailState.message && (
            <p aria-live="polite" className="mt-2 text-xs text-[var(--text-secondary)]">
              {emailState.message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function DossierRefresh({ customerId }: { customerId: string }) {
  const [state, action, pending] = useActionState(requestDossierRefresh, initial);

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="customerId" value={customerId} />
      <Button
        type="submit"
        variant="secondary"
        size="xs"
        isLoading={pending}
        leftIcon={<Sparkles className="w-3.5 h-3.5 text-indigo-600" />}
      >
        Làm mới phân tích AI
      </Button>
      {state.message && (
        <span aria-live="polite" className="text-[11px] text-[var(--text-secondary)]">
          {state.message}
        </span>
      )}
    </form>
  );
}

export function DossierNote({ customerId }: { customerId: string }) {
  const [state, action, pending] = useActionState(saveDossierNote, initial);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ghi chú của Chuyên viên Sale</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-3">
          <input type="hidden" name="customerId" value={customerId} />
          <textarea
            id="dossier-note"
            name="note"
            required
            maxLength={2000}
            rows={3}
            placeholder="Ghi nhận trao đổi trực tiếp, thỏa thuận riêng hoặc lưu ý khi thi công..."
            className="w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
          <div className="flex items-center justify-between">
            <Button
              type="submit"
              variant="primary"
              size="xs"
              isLoading={pending}
              leftIcon={<Save className="w-3.5 h-3.5" />}
            >
              Lưu ghi chú
            </Button>
            {state.message && (
              <p aria-live="polite" className="text-xs text-[var(--text-secondary)]">
                {state.message}
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
