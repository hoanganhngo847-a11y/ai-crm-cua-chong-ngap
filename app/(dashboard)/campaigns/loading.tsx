export default function Loading() {
  return (
    <div role="status" className="animate-pulse space-y-4 p-6">
      <p>Đang tải chiến dịch…</p>
      <div className="h-32 rounded-xl bg-[var(--surface-secondary)]" />
    </div>
  );
}
