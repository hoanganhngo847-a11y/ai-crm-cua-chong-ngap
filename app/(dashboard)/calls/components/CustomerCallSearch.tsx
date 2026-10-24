'use client';

import { FormEvent, useState, useTransition } from 'react';
import { searchCustomersForCallAction } from '../../../actions/voice';
import type { CustomerSearchResultDTO } from '../../../../shared/contracts/voice';
import CallToCustomerButton from './CallToCustomerButton';
import { Card, CardTitle } from '../../../../components/ui/card';
import { Button } from '../../../../components/ui/button';
import { Search, PhoneCall } from 'lucide-react';

export default function CustomerCallSearch({ provider }: { provider: string }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CustomerSearchResultDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await searchCustomersForCallAction({ query, pageSize: 10 });
      setSearched(true);
      if (!result.success || !result.data) {
        setItems([]);
        setError(result.error || 'Không thể tìm khách hàng.');
        return;
      }
      setItems(result.data.items);
    });
  }

  return (
    <Card className="p-5 space-y-4">
      <div>
        <CardTitle className="flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-emerald-600" />
          <span>Tìm kiếm khách hàng để gọi điện</span>
        </CardTitle>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Tìm theo tên hoặc mã khách hàng. Số điện thoại thực được bảo vệ tuyệt đối theo chính sách Zero-Phone.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2.5">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[var(--text-tertiary)] pointer-events-none" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            minLength={2}
            maxLength={100}
            required
            placeholder="Nhập tên khách hàng hoặc mã KH-xxxxxx..."
            aria-label="Tên hoặc mã khách hàng"
            className="w-full h-8 pl-8 pr-3 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>

        <Button
          type="submit"
          variant="primary"
          size="sm"
          isLoading={pending}
          leftIcon={<Search className="w-3.5 h-3.5" />}
        >
          Tìm khách hàng
        </Button>
      </form>

      {error && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
          {error}
        </div>
      )}

      {searched && (
        <div className="pt-2 border-t border-[var(--border-subtle)] space-y-2">
          <div className="text-[11px] font-medium text-[var(--text-secondary)]">
            Kết quả tìm kiếm ({items.length})
          </div>

          {items.length === 0 ? (
            <div className="p-4 text-center text-xs text-[var(--text-tertiary)] italic">
              Không tìm thấy khách hàng nào khớp với từ khóa &ldquo;{query}&rdquo;.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)] border border-[var(--border-subtle)] rounded-lg overflow-hidden">
              {items.map((c) => (
                <li
                  key={c.id}
                  className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[var(--surface-primary)] hover:bg-[var(--surface-hover)] transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-secondary)] text-xs font-semibold">
                      {c.name ? c.name[0].toUpperCase() : 'K'}
                    </div>
                    <div>
                      <div className="font-medium text-xs text-[var(--text-primary)]">
                        {c.name || 'Chưa có tên'}
                      </div>
                      <div className="text-[11px] font-mono text-[var(--text-tertiary)]">
                        {c.customerCode || c.id}
                      </div>
                    </div>
                  </div>

                  <CallToCustomerButton
                    customerId={c.id}
                    customerCode={c.customerCode}
                    customerName={c.name}
                    provider={provider}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
