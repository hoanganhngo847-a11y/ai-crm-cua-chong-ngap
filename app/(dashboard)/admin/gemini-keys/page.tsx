import React from 'react';
import { connection } from 'next/server';
import {
  addGeminiApiKeys,
  deleteGeminiApiKey,
  getGeminiKeyPoolState,
  toggleGeminiApiKey,
} from '../../../actions/gemini-key-pool';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

export default async function GeminiKeysPage() {
  await connection();
  const keys = await getGeminiKeyPoolState();
  const ready = keys.filter((item) => item.enabled && !item.cooldown_active).length;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Quản trị hệ thống', href: '/admin' },
          { label: 'Gemini Provider Pool' },
        ]}
        title="Gemini Provider Pool"
        description="Tối đa 30 credentials từ các project khác nhau. Khi gặp 429, worker tự động chuyển sang credential kế tiếp và áp dụng cooldown."
      />

      {/* Metrics */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="p-5">
          <div className="text-xs text-text-tertiary">Đã lưu</div>
          <div className="text-2xl font-bold text-text-primary mt-1">{keys.length}/30</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs text-text-tertiary">Sẵn sàng</div>
          <div className="text-2xl font-bold text-emerald-600 mt-1">{ready}</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs text-text-tertiary">Đang bật</div>
          <div className="text-2xl font-bold text-accent mt-1">{keys.filter((item) => item.enabled).length}</div>
        </Card>
      </div>

      {/* Add Keys Form */}
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-4 pb-3 border-b border-border-subtle">
          <Plus className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Thêm Credentials vào Pool</h2>
        </div>
        <form action={addGeminiApiKeys} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Tên nhóm</label>
            <input
              name="labelPrefix"
              defaultValue="Gemini Project"
              maxLength={80}
              className="w-full rounded-lg border border-border-subtle bg-surface-primary px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">Credentials (mỗi dòng một giá trị)</label>
            <textarea
              name="keys"
              required
              rows={8}
              autoComplete="off"
              spellCheck={false}
              placeholder="AIzaSy..."
              className="w-full rounded-lg border border-border-subtle bg-surface-primary px-3 py-2 font-mono text-xs text-text-primary focus:outline-none focus:border-accent resize-none"
            />
          </div>
          <div className="flex items-center justify-between gap-3 pt-2">
            <p className="text-[11px] text-text-tertiary">
              Giá trị được mã hóa ở server và không hiển thị lại sau khi lưu.
            </p>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={keys.length >= 30}
            >
              Lưu vào pool
            </Button>
          </div>
        </form>
      </Card>

      {/* Key List */}
      <Card className="overflow-hidden">
        <div className="border-b border-border-subtle px-5 py-3 font-semibold text-text-primary text-xs bg-surface-secondary">
          Danh sách Credential trong Pool ({keys.length})
        </div>
        {keys.length === 0 ? (
          <div className="p-8 text-center text-xs text-text-tertiary">Chưa có credential nào.</div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {keys.map((item) => {
              const cooling = item.cooldown_active;
              return (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-surface-hover transition-colors">
                  <div>
                    <div className="font-medium text-text-primary text-xs flex items-center gap-2">
                      <span>{item.label}</span>
                      <Badge variant={!item.enabled ? 'neutral' : cooling ? 'warning' : 'success'}>
                        {!item.enabled ? 'Đã tắt' : cooling ? 'Cooldown' : 'Sẵn sàng'}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[11px] text-text-tertiary">
                      Lỗi gần nhất: {item.last_error_code || '—'} · 429 liên tiếp: {item.consecutive_rate_limits}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <form action={toggleGeminiApiKey}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="enabled" value={item.enabled ? 'false' : 'true'} />
                      <Button type="submit" variant="secondary" size="sm">
                        {item.enabled ? 'Tắt' : 'Bật'}
                      </Button>
                    </form>
                    <form action={deleteGeminiApiKey}>
                      <input type="hidden" name="id" value={item.id} />
                      <Button type="submit" variant="secondary" size="sm" className="text-danger hover:text-danger hover:bg-rose-50">
                        Xóa
                      </Button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
