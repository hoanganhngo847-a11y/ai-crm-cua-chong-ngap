import React from 'react';
import Link from 'next/link';
import { getActorContext } from '../../../lib/auth/context';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart3, Bot, PhoneCall, Key, ArrowRight, Megaphone } from 'lucide-react';

export default async function AdminDashboardPage() {
  const actor = await getActorContext();

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[
          { label: 'Quản trị hệ thống' },
        ]}
        title="Bảng điều khiển Quản trị viên"
        description="Khu vực bảo mật: Quản lý nhân sự, chính sách giá, trung tâm AI và tài chính doanh nghiệp."
        primaryAction={
          <Badge variant="neutral">
            Vai trò: {actor?.role || 'BOSS_ADMIN'}
          </Badge>
        }
      />

      {/* Security Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 space-y-2">
          <div className="text-xs font-medium text-text-tertiary">Xác thực 2 yếu tố (MFA)</div>
          <div className="text-base font-semibold text-text-primary flex items-center gap-2">
            <span>Cấp độ:</span>
            <Badge variant="success">
              {actor?.aal?.toUpperCase() || 'AAL1'}
            </Badge>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Theo AUTH DECISION 01, tài khoản BOSS_ADMIN yêu cầu AAL2 khi truy cập dữ liệu nhạy cảm.
          </p>
        </Card>

        <Card className="p-5 space-y-2">
          <div className="text-xs font-medium text-text-tertiary">Quyền hạn Doanh nghiệp</div>
          <div className="text-base font-semibold text-accent font-mono">{actor?.role}</div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Ủy quyền quản trị toàn bộ dữ liệu thuộc Company: <span className="font-mono text-text-primary">{actor?.companyId?.slice(0, 8)}...</span>
          </p>
        </Card>

        <Card className="p-5 space-y-2">
          <div className="text-xs font-medium text-text-tertiary">Trạng thái Hồ sơ</div>
          <div className="text-base font-semibold text-emerald-700 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>{actor?.profileStatus}</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Hồ sơ người dùng ứng dụng và tư cách thành viên đều đang ACTIVE.
          </p>
        </Card>
      </div>

      {/* Navigation Sections */}
      <div className="space-y-3">
        <Card className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-border-strong transition-colors">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center shrink-0 mt-0.5">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">Analytics doanh nghiệp (Báo cáo & Thống kê)</h2>
                <Badge variant="neutral">M9.5</Badge>
              </div>
              <p className="text-xs text-text-secondary mt-1 max-w-2xl leading-relaxed">
                Theo dõi toàn diện các chỉ số kinh doanh, phễu khách hàng, thời gian phản hồi SLA 5 phút, hoạt động khảo sát, và ảnh chụp tình hình tài chính doanh nghiệp.
              </p>
            </div>
          </div>
          <Link
            href="/admin/analytics"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover text-xs font-medium transition shrink-0 self-start md:self-auto"
          >
            <span>Mở Dashboard</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </Card>

        <Card className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-border-strong transition-colors">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center shrink-0 mt-0.5 border border-purple-200">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">AI Control Center (Trung tâm Điều khiển AI)</h2>
                <Badge variant="ai">Phase 8</Badge>
              </div>
              <p className="text-xs text-text-secondary mt-1 max-w-2xl leading-relaxed">
                Quản trị toàn diện tự động trả lời đa kênh (Zalo, Messenger, Voice), ngắt khẩn cấp Kill Switch, ngưỡng độ tin cậy, model routing, và hộp thư chuyển giao tư vấn viên.
              </p>
            </div>
          </div>
          <Link
            href="/admin/ai"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-surface-secondary text-text-primary hover:bg-surface-hover border border-border-subtle text-xs font-medium transition shrink-0 self-start md:self-auto"
          >
            <span>Mở AI Control Center</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </Card>

        <Card className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-border-strong transition-colors">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 mt-0.5 border border-blue-200">
              <PhoneCall className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">AI Call Pipeline</h2>
              <p className="text-xs text-text-secondary mt-1 max-w-2xl leading-relaxed">
                Theo dõi luồng Recording → Transcription → AI Summary, lỗi canonical và trạng thái Gemini pool.
              </p>
            </div>
          </div>
          <Link
            href="/admin/ai-call-pipeline"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-surface-secondary text-text-primary hover:bg-surface-hover border border-border-subtle text-xs font-medium transition shrink-0 self-start md:self-auto"
          >
            <span>Mở AI Pipeline</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </Card>

        <Card className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-border-strong transition-colors">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0 mt-0.5 border border-blue-200">
              <Megaphone className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-text-primary">Meta Ads Integration &amp; Attribution</h2>
                <Badge variant="success">Active</Badge>
              </div>
              <p className="text-xs text-text-secondary mt-1 max-w-2xl leading-relaxed">
                Kết nối Facebook Pages và tài khoản quảng cáo để xác định chiến dịch tạo ra từng lượt đăng ký của khách hàng.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-start md:self-auto">
            <Link
              href="/admin/facebook"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover text-xs font-medium transition"
            >
              <span>Cấu hình Meta</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </Card>

        <Card className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-border-strong transition-colors">
          <div className="flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0 mt-0.5 border border-emerald-200">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Gemini Pool</h2>
              <p className="text-xs text-text-secondary mt-1 max-w-2xl leading-relaxed">
                Quản lý 30 slot Gemini và theo dõi trạng thái xoay vòng/cooldown.
              </p>
            </div>
          </div>
          <Link
            href="/admin/gemini-keys"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-surface-secondary text-text-primary hover:bg-surface-hover border border-border-subtle text-xs font-medium transition shrink-0 self-start md:self-auto"
          >
            <span>Mở Gemini Pool</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </Card>
      </div>
    </div>
  );
}
