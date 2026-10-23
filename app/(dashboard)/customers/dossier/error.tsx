'use client';

export default function DossierListError({ reset }: { reset: () => void }) {
  return <div role="alert" className="space-y-4 p-8 text-slate-200"><h2 className="text-xl">Không tải được Customer 360</h2><p>Kiểm tra quyền truy cập, kết nối và migration. Danh sách hiện chưa xác định.</p><button onClick={reset} className="rounded-lg bg-blue-600 px-4 py-2">Thử lại</button></div>;
}
