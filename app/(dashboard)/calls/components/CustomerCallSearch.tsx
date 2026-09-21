'use client';

import { FormEvent, useState, useTransition } from 'react';
import { searchCustomersForCallAction } from '../../../actions/voice';
import type { CustomerSearchResultDTO } from '../../../../shared/contracts/voice';
import CallToCustomerButton from './CallToCustomerButton';

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
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4">
      <div>
        <h2 className="font-semibold text-white">Tìm khách để gọi</h2>
        <p className="mt-1 text-xs text-slate-400">Tìm bằng tên hoặc mã khách; số thật chỉ được xử lý phía máy chủ.</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          minLength={2}
          maxLength={100}
          required
          placeholder="Nguyễn Văn A hoặc KH-000123"
          aria-label="Tên hoặc mã khách hàng"
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-wait disabled:bg-blue-900"
        >
          {pending ? 'Đang tìm…' : 'Tìm khách'}
        </button>
      </form>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {searched && !error && items.length === 0 && <p className="text-sm text-slate-400">Không tìm thấy khách phù hợp.</p>}
      {items.length > 0 && (
        <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">
          {items.map((customer) => (
            <div key={customer.id} className="p-4">
              <CallToCustomerButton
                customerId={customer.id}
                customerCode={customer.customerCode}
                customerName={customer.name}
                provider={provider}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
