import Link from 'next/link';
import { getActorContext, requireBossAdmin } from '@/lib/auth/context';
import { PageHeader } from '@/components/ui/page-header';
import { ZaloAccountsPanel } from './zalo-accounts-panel';

export default async function ZaloAccountsPage() {
  const actor = await getActorContext();
  if (!actor?.companyId) return <p>Vui lòng đăng nhập tài khoản quản trị.</p>;
  await requireBossAdmin(actor.companyId, { requireAal2: true });
  return <div className="space-y-6">
    <PageHeader title="Thêm tài khoản Zalo" description="Kết nối thêm tài khoản để nhận và trả lời tin nhắn ngay trong Hộp thư. Mỗi tài khoản được quản lý riêng."
      breadcrumbs={[{ label: 'Quản trị hệ thống', href: '/admin' }, { label: 'Thêm tài khoản Zalo' }]}
      primaryAction={<Link href="/inbox" className="rounded-lg border border-border-subtle px-4 py-2 text-xs font-medium hover:bg-surface-hover">Mở Hộp thư</Link>} />
    <ZaloAccountsPanel />
  </div>;
}
