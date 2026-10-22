import React from 'react';
import {
  addGeminiApiKeys,
  deleteGeminiApiKey,
  getGeminiKeyPoolState,
  toggleGeminiApiKey,
} from '../../../actions/gemini-key-pool';

export default async function GeminiKeysPage() {
  const keys = await getGeminiKeyPoolState();
  const ready = keys.filter((item) => item.enabled && !item.cooldown_active).length;

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-white">Gemini Provider Pool</h1>
        <p className="mt-1 text-sm text-slate-400">Tối đa 30 credentials từ các project khác nhau. Khi một credential gặp 429, worker chuyển sang credential kế tiếp và tạm cooldown credential vừa lỗi.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="text-xs text-slate-500">Đã lưu</div><div className="text-2xl font-bold text-white">{keys.length}/30</div></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="text-xs text-slate-500">Sẵn sàng</div><div className="text-2xl font-bold text-emerald-400">{ready}</div></div>
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5"><div className="text-xs text-slate-500">Đang bật</div><div className="text-2xl font-bold text-blue-400">{keys.filter((item) => item.enabled).length}</div></div>
      </div>

      <form action={addGeminiApiKeys} className="space-y-4 rounded-xl border border-blue-500/20 bg-slate-900 p-6">
        <div>
          <label className="mb-1 block text-sm text-slate-300">Tên nhóm</label>
          <input name="labelPrefix" defaultValue="Gemini Project" maxLength={80} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
        </div>
        <div>
          <label className="mb-1 block text-sm text-slate-300">Credentials, mỗi dòng một giá trị</label>
          <textarea name="keys" required rows={12} autoComplete="off" spellCheck={false} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 font-mono text-xs text-white" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-slate-500">Giá trị được mã hóa ở server và không hiển thị lại sau khi lưu.</p>
          <button type="submit" disabled={keys.length >= 30} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Lưu vào pool</button>
        </div>
      </form>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="border-b border-slate-800 px-5 py-4 font-semibold text-white">Danh sách</div>
        {keys.length === 0 ? <div className="p-6 text-sm text-slate-500">Chưa có credential nào.</div> : (
          <div className="divide-y divide-slate-800">
            {keys.map((item) => {
              const cooling = item.cooldown_active;
              return (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div>
                    <div className="font-medium text-white">{item.label}</div>
                    <div className="mt-1 text-xs text-slate-500">{!item.enabled ? 'Tắt' : cooling ? 'Cooldown' : 'Sẵn sàng'} · lỗi gần nhất: {item.last_error_code || '—'} · 429 liên tiếp: {item.consecutive_rate_limits}</div>
                  </div>
                  <div className="flex gap-2">
                    <form action={toggleGeminiApiKey}>
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="enabled" value={item.enabled ? 'false' : 'true'} />
                      <button type="submit" className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300">{item.enabled ? 'Tắt' : 'Bật'}</button>
                    </form>
                    <form action={deleteGeminiApiKey}>
                      <input type="hidden" name="id" value={item.id} />
                      <button type="submit" className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-400">Xóa</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
