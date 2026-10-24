'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { CustomerResponse } from '../types/customer.types';
import {
  Users,
  Search,
  Plus,
  ShieldCheck,
  ShieldAlert,
  MessageSquare,
  Flame,
} from 'lucide-react';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Select } from '../../../components/ui/select';
import { StatusBadge } from '../../../components/ui/status-badge';
import { Badge } from '../../../components/ui/badge';
import { Avatar } from '../../../components/ui/avatar';
import { Modal } from '../../../components/ui/modal';
import { EmptyState } from '../../../components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TablePagination,
} from '../../../components/ui/data-table';

interface CustomerListProps {
  userRole?: string | null;
  userFullName?: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  FACEBOOK: 'Facebook',
  ZALO: 'Zalo OA',
  ZALO_OA: 'Zalo OA',
  WEBSITE: 'Website',
  HOTLINE: 'Hotline',
  ADVERTISING: 'Quảng cáo',
  MANUAL: 'Nhập thủ công',
};

export default function CustomerList({ userRole }: CustomerListProps) {
  const [customers, setCustomers] = useState<CustomerResponse[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Tab: 'ALL' vs 'URGENT_CLOSING' (Hàng chờ CẦN SALE CHỐT)
  const [activeTab, setActiveTab] = useState<'ALL' | 'URGENT_CLOSING'>('ALL');
  const [urgentCount, setUrgentCount] = useState<number>(0);

  // Filters & Pagination
  const [search, setSearch] = useState<string>('');
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [selectedStage, setSelectedStage] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [total, setTotal] = useState<number>(0);
  const limit = 15;

  // Add Customer Modal
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    source: 'MANUAL',
    channel: '',
    external_id: '',
  });
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formNotification, setFormNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Quick Stage Update Modal
  const [selectedCustomerForStage, setSelectedCustomerForStage] =
    useState<CustomerResponse | null>(null);
  const [targetStage, setTargetStage] = useState<string>('');
  const [stageNote, setStageNote] = useState<string>('');
  const [updatingStage, setUpdatingStage] = useState<boolean>(false);
  const [stageNotification, setStageNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const fetchCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (selectedSource) params.set('source', selectedSource);
      if (selectedStage) params.set('stage', selectedStage);
      if (activeTab === 'URGENT_CLOSING') params.set('urgent_closing', 'true');
      params.set('limit', limit.toString());
      params.set('offset', ((page - 1) * limit).toString());

      const res = await fetch(`/api/customers?${params.toString()}`);
      const json = await res.json();

      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Không thể tải danh sách khách hàng.');
      }

      setCustomers(json.data || []);
      setTotal(json.pagination?.total || 0);

      if (Array.isArray(json.data)) {
        const uCount = json.data.filter((c: CustomerResponse) =>
          Boolean(c.urgency_reason)
        ).length;
        if (activeTab === 'ALL') {
          setUrgentCount(uCount);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Đã có lỗi xảy ra.');
    } finally {
      setLoading(false);
    }
  }, [search, selectedSource, selectedStage, page, activeTab]);

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      if (isMounted) await fetchCustomers();
    };
    void load();
    return () => {
      isMounted = false;
    };
  }, [fetchCustomers]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchCustomers();
  };

  const handleResetFilters = () => {
    setSearch('');
    setSelectedSource('');
    setSelectedStage('');
    setActiveTab('ALL');
    setPage(1);
  };

  const handleUpdateStageSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomerForStage || !targetStage) return;

    setUpdatingStage(true);
    setStageNotification(null);

    try {
      const res = await fetch(
        `/api/customers/${selectedCustomerForStage.id}/stage`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            stage: targetStage,
            note: stageNote.trim() || undefined,
          }),
        }
      );

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Không thể cập nhật giai đoạn.');
      }

      setStageNotification({
        type: 'success',
        message: 'Cập nhật giai đoạn thành công!',
      });

      // Update in place
      setCustomers((prev) =>
        prev.map((c) =>
          c.id === selectedCustomerForStage.id
            ? { ...c, stage: targetStage as CustomerResponse['stage'] }
            : c
        )
      );

      setTimeout(() => {
        setSelectedCustomerForStage(null);
        setStageNotification(null);
      }, 1200);
    } catch (err: unknown) {
      setStageNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Lỗi không xác định.',
      });
    } finally {
      setUpdatingStage(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || !formData.phone.trim()) {
      setFormNotification({
        type: 'error',
        message: 'Họ tên và số điện thoại là thông tin bắt buộc.',
      });
      return;
    }

    setSubmitting(true);
    setFormNotification(null);

    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name.trim(),
          phone: formData.phone.trim(),
          source: formData.source,
          channel: formData.channel || undefined,
          external_id: formData.external_id || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Lỗi khi lưu khách hàng.');
      }

      setFormNotification({
        type: 'success',
        message: json.message || 'Thao tác thành công!',
      });

      setFormData({
        name: '',
        phone: '',
        source: 'MANUAL',
        channel: '',
        external_id: '',
      });

      fetchCustomers();

      setTimeout(() => {
        setIsModalOpen(false);
        setFormNotification(null);
      }, 1500);
    } catch (err: unknown) {
      setFormNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Lỗi không xác định.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const totalPages = Math.ceil(total / limit) || 1;
  const isSale = userRole === 'SALE';
  const isBossAdmin = userRole === 'BOSS_ADMIN';

  return (
    <div className="space-y-6">
      {/* Top Banner & Security Indicator */}
      <Card className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-semibold text-[var(--text-primary)] tracking-tight">
              Quản Lý Khách Hàng
            </h1>
            <Badge variant="accent" size="sm">
              Hành trình mua hàng
            </Badge>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Quản lý tập trung thông tin, danh tính đa kênh và phân quyền bảo mật số điện thoại.
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Privacy Indicator Badge */}
          {isSale ? (
            <Badge variant="warning" size="sm" className="font-mono">
              <ShieldAlert className="w-3.5 h-3.5 mr-1" />
              Zero-Phone (Masked: 09******12)
            </Badge>
          ) : isBossAdmin ? (
            <Badge variant="success" size="sm" className="font-mono">
              <ShieldCheck className="w-3.5 h-3.5 mr-1" />
              Quản trị viên (Số thật &amp; Audit Log)
            </Badge>
          ) : null}

          <Button
            onClick={() => setIsModalOpen(true)}
            id="add-customer-btn"
            variant="primary"
            size="sm"
            leftIcon={<Plus className="w-3.5 h-3.5" />}
          >
            Thêm khách hàng
          </Button>
        </div>
      </Card>

      {/* Navigation Tabs: Tất cả vs Hàng chờ CẦN SALE CHỐT */}
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-2 select-none">
        <button
          type="button"
          onClick={() => {
            setActiveTab('ALL');
            setPage(1);
          }}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
            activeTab === 'ALL'
              ? 'bg-[var(--surface-primary)] text-[var(--text-primary)] shadow-xs border border-[var(--border-subtle)] font-semibold'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>Tất cả khách hàng</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('URGENT_CLOSING');
            setPage(1);
          }}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
            activeTab === 'URGENT_CLOSING'
              ? 'bg-amber-50 text-amber-700 border border-amber-200 font-semibold'
              : 'text-[var(--text-secondary)] hover:text-amber-700 hover:bg-amber-50/50'
          }`}
        >
          <Flame className="w-3.5 h-3.5 text-amber-600" />
          <span>CẦN SALE CHỐT GẤP</span>
          {urgentCount > 0 && (
            <span className="px-1.5 py-0.2 text-[10px] rounded-full bg-amber-600 text-white font-mono font-bold">
              {urgentCount}
            </span>
          )}
        </button>
      </div>

      {/* Filter and Search Bar */}
      <Card className="p-3.5 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
          {/* Search Box */}
          <div className="md:col-span-2">
            <form onSubmit={handleSearchSubmit} className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-tertiary)] pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm kiếm theo tên khách hoặc mã KH-xxxxxx..."
                className="w-full h-8 pl-8 pr-3 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
            </form>
          </div>

          {/* Filter by Source */}
          <div>
            <select
              value={selectedSource}
              onChange={(e) => {
                setSelectedSource(e.target.value);
                setPage(1);
              }}
              className="w-full h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Tất cả nguồn</option>
              <option value="FACEBOOK">Facebook</option>
              <option value="ZALO">Zalo OA</option>
              <option value="WEBSITE">Website</option>
              <option value="HOTLINE">Hotline</option>
              <option value="ADVERTISING">Quảng cáo</option>
              <option value="MANUAL">Nhập thủ công</option>
            </select>
          </div>

          {/* Filter by Stage */}
          <div>
            <select
              value={selectedStage}
              onChange={(e) => {
                setSelectedStage(e.target.value);
                setPage(1);
              }}
              className="w-full h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            >
              <option value="">Tất cả giai đoạn</option>
              <option value="LEAD_NEW">Khách mới</option>
              <option value="CONTACT_CYCLE_1">Đang liên hệ (Gọi 1)</option>
              <option value="CONTACT_CYCLE_2">Đang liên hệ (Gọi 2)</option>
              <option value="CONTACT_CYCLE_3">Đang liên hệ (Gọi 3)</option>
              <option value="UNREACHABLE">Không liên lạc được</option>
              <option value="SURVEY_SCHEDULED">Lịch khảo sát</option>
              <option value="SURVEY_COMPLETED">Đã khảo sát</option>
              <option value="PRICE_OFFERED">Đã báo giá</option>
              <option value="NEGOTIATING">Đang thương lượng</option>
              <option value="ORDER_CREATED">Đã tạo đơn</option>
              <option value="DEPOSIT_CONFIRMED">Đã đặt cọc</option>
              <option value="CONTRACT_SIGNED">Đã ký hợp đồng</option>
              <option value="IN_PRODUCTION">Đang sản xuất</option>
              <option value="INSTALLING">Đang lắp đặt</option>
              <option value="HANDOVER_COMPLETED">Hoàn tất bàn giao</option>
            </select>
          </div>
        </div>

        {/* Active Filters summary & Reset */}
        {(search || selectedSource || selectedStage) && (
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] pt-2 border-t border-[var(--border-subtle)]">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-[var(--text-tertiary)]">Đang lọc:</span>
              {search && (
                <span className="px-2 py-0.5 rounded bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[11px]">
                  Từ khóa: &ldquo;{search}&rdquo;
                </span>
              )}
              {selectedSource && (
                <span className="px-2 py-0.5 rounded bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[11px]">
                  Nguồn: {SOURCE_LABELS[selectedSource] || selectedSource}
                </span>
              )}
              {selectedStage && (
                <span className="px-2 py-0.5 rounded bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[11px]">
                  Giai đoạn: {selectedStage}
                </span>
              )}
            </div>
            <button
              onClick={handleResetFilters}
              className="text-[var(--accent)] hover:underline font-medium cursor-pointer"
            >
              Đặt lại bộ lọc
            </button>
          </div>
        )}
      </Card>

      {/* Customer Data Table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="h-10 bg-[var(--surface-secondary)] rounded-lg animate-pulse"
              />
            ))}
          </div>
        ) : error ? (
          <div className="p-8">
            <EmptyState
              type="error"
              title="Không thể tải danh sách khách hàng"
              description={error}
              onRetry={() => fetchCustomers()}
            />
          </div>
        ) : customers.length === 0 ? (
          <div className="p-8">
            <EmptyState
              type={search || selectedSource || selectedStage ? 'no-results' : 'empty'}
              title={
                search || selectedSource || selectedStage
                  ? 'Không tìm thấy khách hàng nào'
                  : 'Chưa có khách hàng'
              }
              description={
                search || selectedSource || selectedStage
                  ? 'Không có khách hàng nào phù hợp với bộ lọc tìm kiếm.'
                  : 'Chưa có bản ghi khách hàng nào được tạo.'
              }
              action={{
                label: 'Thêm khách hàng',
                onClick: () => setIsModalOpen(true),
              }}
            />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Mã KH</TableHead>
                <TableHead className="min-w-[200px]">Họ và Tên</TableHead>
                <TableHead className="min-w-[140px]">Số điện thoại</TableHead>
                <TableHead className="min-w-[120px]">Nguồn</TableHead>
                <TableHead className="min-w-[140px]">Giai đoạn</TableHead>
                <TableHead className="min-w-[120px]">Ngày tạo</TableHead>
                <TableHead className="text-right min-w-[160px]">Thao tác</TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {customers.map((c) => (
                <TableRow key={c.id}>
                  {/* Customer Code */}
                  <TableCell>
                    <Link
                      href={`/customers/${c.id}/dossier`}
                      className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-[var(--surface-secondary)] border border-[var(--border-subtle)] text-[var(--accent)] hover:border-[var(--accent)] transition-colors inline-block"
                    >
                      {c.customer_code}
                    </Link>
                  </TableCell>

                  {/* Name */}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar name={c.name} size="xs" />
                      <Link
                        href={`/customers/${c.id}/dossier`}
                        className="font-medium text-[var(--text-primary)] hover:text-[var(--accent)] transition-colors truncate"
                      >
                        {c.name}
                      </Link>
                    </div>
                  </TableCell>

                  {/* Phone */}
                  <TableCell>
                    {c.phone ? (
                      <span
                        className={`inline-flex items-center gap-1 font-mono text-xs px-2 py-0.5 rounded border ${
                          c.is_phone_masked
                            ? 'bg-amber-50 border-amber-200 text-amber-700'
                            : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        }`}
                      >
                        {c.phone}
                      </span>
                    ) : (
                      <span className="text-[var(--text-tertiary)] italic text-xs">Chưa có số</span>
                    )}
                  </TableCell>

                  {/* Source */}
                  <TableCell>
                    <span className="text-xs text-[var(--text-secondary)]">
                      {SOURCE_LABELS[c.source] || c.source}
                    </span>
                  </TableCell>

                  {/* Stage & Urgency */}
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge status={c.stage} size="xs" />
                      {c.urgency_reason && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                          ⚡ {c.urgency_label || 'Cần sale chốt'}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  {/* Created At */}
                  <TableCell>
                    <span className="text-xs text-[var(--text-secondary)] font-mono">
                      {new Date(c.created_at).toLocaleDateString('vi-VN')}
                    </span>
                  </TableCell>

                  {/* Actions */}
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setSelectedCustomerForStage(c);
                          setTargetStage(c.stage);
                          setStageNote('');
                          setStageNotification(null);
                        }}
                      >
                        Đổi trạng thái
                      </Button>
                      <Link href={`/inbox?customer_id=${c.id}`}>
                        <Button variant="outline" size="xs" aria-label="Mở chat">
                          <MessageSquare className="w-3 h-3 text-blue-600" />
                        </Button>
                      </Link>
                      <Link href={`/customers/${c.id}/dossier`}>
                        <Button variant="primary" size="xs">
                          360
                        </Button>
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {/* Pagination */}
        {!loading && customers.length > 0 && (
          <TablePagination
            currentPage={page}
            totalPages={totalPages}
            totalItems={total}
            pageSize={limit}
            onPageChange={(p) => setPage(p)}
          />
        )}
      </Card>

      {/* Modal: Thêm Khách Hàng Mới */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Tiếp Nhận Khách Hàng Mới"
        description="Số điện thoại được dùng làm khóa chính để tự động gộp khách hàng trùng lặp."
      >
        {formNotification && (
          <div
            className={`p-3 rounded-lg text-xs border mb-4 ${
              formNotification.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            {formNotification.message}
          </div>
        )}

        <form onSubmit={handleCreateCustomer} className="space-y-4">
          <Input
            label="Họ và tên khách hàng *"
            required
            placeholder="Ví dụ: Anh Tuấn - Cầu Giấy"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          />

          <Input
            label="Số điện thoại *"
            type="tel"
            required
            placeholder="0912345678"
            value={formData.phone}
            onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
            className="font-mono"
          />

          <div className="grid grid-cols-2 gap-3">
            <Select
              label="Nguồn tiếp nhận"
              value={formData.source}
              onChange={(e) => setFormData({ ...formData, source: e.target.value })}
            >
              <option value="MANUAL">Nhập thủ công</option>
              <option value="HOTLINE">Hotline</option>
              <option value="FACEBOOK">Facebook Fanpage</option>
              <option value="ZALO">Zalo OA</option>
              <option value="WEBSITE">Website</option>
              <option value="ADVERTISING">Quảng cáo</option>
            </Select>

            <Select
              label="Liên kết kênh xã hội"
              value={formData.channel}
              onChange={(e) => setFormData({ ...formData, channel: e.target.value })}
            >
              <option value="">Không liên kết</option>
              <option value="ZALO">Zalo UID</option>
              <option value="FACEBOOK">Facebook PSID</option>
              <option value="WEBSITE">Website Session</option>
            </Select>
          </div>

          {formData.channel && (
            <Input
              label={`Mã định danh bên ngoài (${formData.channel} ID)`}
              placeholder="Nhập UID hoặc ID kênh..."
              value={formData.external_id}
              onChange={(e) => setFormData({ ...formData, external_id: e.target.value })}
              className="font-mono"
            />
          )}

          <div className="pt-3 flex items-center justify-end gap-2 border-t border-[var(--border-subtle)]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsModalOpen(false)}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={submitting}
            >
              Lưu khách hàng
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Chuyển Giai Đoạn Khách Hàng */}
      <Modal
        isOpen={!!selectedCustomerForStage}
        onClose={() => setSelectedCustomerForStage(null)}
        title="Chuyển Giai Đoạn Vòng Đời"
        description={
          selectedCustomerForStage
            ? `${selectedCustomerForStage.customer_code} • ${selectedCustomerForStage.name}`
            : undefined
        }
      >
        {stageNotification && (
          <div
            className={`p-3 rounded-lg text-xs border mb-4 ${
              stageNotification.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            {stageNotification.message}
          </div>
        )}

        <form onSubmit={handleUpdateStageSubmit} className="space-y-4">
          <Select
            label="Chọn giai đoạn mới"
            value={targetStage}
            onChange={(e) => setTargetStage(e.target.value)}
          >
            <option value="LEAD_NEW">Khách mới</option>
            <option value="CONTACT_CYCLE_1">Đang liên hệ (Gọi 1)</option>
            <option value="CONTACT_CYCLE_2">Đang liên hệ (Gọi 2)</option>
            <option value="CONTACT_CYCLE_3">Đang liên hệ (Gọi 3)</option>
            <option value="UNREACHABLE">Không liên lạc được</option>
            <option value="SURVEY_REQUESTED">Yêu cầu khảo sát</option>
            <option value="SURVEY_SCHEDULED">Đã lên lịch khảo sát</option>
            <option value="SURVEY_COMPLETED">Đã khảo sát hiện trường</option>
            <option value="PRICE_OFFERED">Đã báo giá phương án</option>
            <option value="NEGOTIATING">Đang đàm phán chốt giá</option>
            <option value="ORDER_CREATED">Đã tạo đơn hàng</option>
            <option value="DEPOSIT_CONFIRMED">Đã đặt cọc</option>
            <option value="CONTRACT_SIGNED">Đã ký hợp đồng</option>
            <option value="IN_PRODUCTION">Đang sản xuất</option>
            <option value="READY_FOR_INSTALL">Sẵn sàng lắp đặt</option>
            <option value="INSTALLING">Đang thi công lắp đặt</option>
            <option value="HANDOVER_COMPLETED">Hoàn tất bàn giao</option>
            <option value="LOST">Mất khách / Đã hủy</option>
          </Select>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              Ghi chú lý do chuyển giai đoạn (tùy chọn)
            </label>
            <textarea
              value={stageNote}
              onChange={(e) => setStageNote(e.target.value)}
              placeholder="VD: Khách hàng đồng ý phương án nhôm 3 ngăn..."
              rows={3}
              className="w-full p-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          <div className="pt-3 flex items-center justify-end gap-2 border-t border-[var(--border-subtle)]">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelectedCustomerForStage(null)}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={updatingStage}
            >
              Xác nhận chuyển giai đoạn
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
