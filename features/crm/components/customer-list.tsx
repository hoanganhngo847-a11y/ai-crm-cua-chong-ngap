'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import type { CustomerResponse, CustomerSource, CustomerStage } from '../types/customer.types';
import { CUSTOMER_SOURCES, CUSTOMER_STAGES } from '../types/customer.types';

interface CustomerListProps {
  userRole?: string | null;
  userFullName?: string | null;
}

const SOURCE_LABELS: Record<string, { label: string; color: string; border: string; bg: string }> = {
  FACEBOOK: { label: 'Facebook', color: 'text-blue-400', border: 'border-blue-700/50', bg: 'bg-blue-950/40' },
  ZALO: { label: 'Zalo', color: 'text-cyan-400', border: 'border-cyan-700/50', bg: 'bg-cyan-950/40' },
  ZALO_OA: { label: 'Zalo OA', color: 'text-cyan-400', border: 'border-cyan-700/50', bg: 'bg-cyan-950/40' },
  WEBSITE: { label: 'Website', color: 'text-purple-400', border: 'border-purple-700/50', bg: 'bg-purple-950/40' },
  HOTLINE: { label: 'Hotline', color: 'text-emerald-400', border: 'border-emerald-700/50', bg: 'bg-emerald-950/40' },
  ADVERTISING: { label: 'Quảng cáo', color: 'text-amber-400', border: 'border-amber-700/50', bg: 'bg-amber-950/40' },
  MANUAL: { label: 'Thủ công', color: 'text-slate-400', border: 'border-slate-700/50', bg: 'bg-slate-800/60' },
};

const STAGE_LABELS: Record<string, { label: string; color: string; border: string; bg: string }> = {
  LEAD_NEW: { label: 'Khách mới', color: 'text-blue-300', border: 'border-blue-700/40', bg: 'bg-blue-900/30' },
  CONTACT_CYCLE_1: { label: 'Gọi lần 1', color: 'text-sky-300', border: 'border-sky-700/40', bg: 'bg-sky-900/30' },
  CONTACT_CYCLE_2: { label: 'Gọi lần 2', color: 'text-amber-300', border: 'border-amber-700/40', bg: 'bg-amber-900/30' },
  CONTACT_CYCLE_3: { label: 'Gọi lần 3', color: 'text-orange-300', border: 'border-orange-700/40', bg: 'bg-orange-900/30' },
  UNREACHABLE: { label: 'Không liên lạc được', color: 'text-rose-400', border: 'border-rose-800/40', bg: 'bg-rose-950/40' },
  SURVEY_REQUESTED: { label: 'Yêu cầu khảo sát', color: 'text-indigo-300', border: 'border-indigo-700/40', bg: 'bg-indigo-900/30' },
  SURVEY_SCHEDULED: { label: 'Đã lên lịch khảo sát', color: 'text-indigo-300', border: 'border-indigo-700/40', bg: 'bg-indigo-900/30' },
  SURVEY_COMPLETED: { label: 'Đã khảo sát', color: 'text-indigo-300', border: 'border-indigo-700/40', bg: 'bg-indigo-900/30' },
  PRICE_CALCULATED: { label: 'Đã tính giá', color: 'text-teal-300', border: 'border-teal-700/40', bg: 'bg-teal-900/30' },
  NEED_INFO: { label: 'Cần thêm thông tin', color: 'text-yellow-300', border: 'border-yellow-700/40', bg: 'bg-yellow-900/30' },
  PRICE_OFFERED: { label: 'Đã báo giá', color: 'text-teal-300', border: 'border-teal-700/40', bg: 'bg-teal-900/30' },
  NEGOTIATING: { label: 'Đang thương lượng', color: 'text-amber-300', border: 'border-amber-700/40', bg: 'bg-amber-900/30' },
  ORDER_CREATED: { label: 'Đã tạo đơn', color: 'text-emerald-300', border: 'border-emerald-700/40', bg: 'bg-emerald-900/30' },
  DEPOSIT_CONFIRMED: { label: 'Đã đặt cọc', color: 'text-emerald-400', border: 'border-emerald-600/50', bg: 'bg-emerald-950/50' },
  CONTRACT_SIGNED: { label: 'Đã ký hợp đồng', color: 'text-emerald-400', border: 'border-emerald-600/50', bg: 'bg-emerald-950/50' },
  IN_PRODUCTION: { label: 'Đang sản xuất', color: 'text-cyan-300', border: 'border-cyan-700/40', bg: 'bg-cyan-900/30' },
  READY_FOR_INSTALL: { label: 'Chờ lắp đặt', color: 'text-cyan-300', border: 'border-cyan-700/40', bg: 'bg-cyan-900/30' },
  INSTALLING: { label: 'Đang lắp đặt', color: 'text-cyan-300', border: 'border-cyan-700/40', bg: 'bg-cyan-900/30' },
  HANDOVER_COMPLETED: { label: 'Hoàn tất bàn giao', color: 'text-emerald-300', border: 'border-emerald-500/50', bg: 'bg-emerald-950/50' },
  WARRANTY_ACTIVE: { label: 'Bảo hành', color: 'text-violet-300', border: 'border-violet-700/40', bg: 'bg-violet-900/30' },
  LOST: { label: 'Đã hủy / Mất', color: 'text-slate-400', border: 'border-slate-700/40', bg: 'bg-slate-800/40' },
  CARE_NURTURING: { label: 'Chăm sóc định kỳ', color: 'text-pink-300', border: 'border-pink-700/40', bg: 'bg-pink-900/30' },
};

export default function CustomerList({ userRole, userFullName }: CustomerListProps) {
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
  const [formNotification, setFormNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Quick Stage Update Modal
  const [selectedCustomerForStage, setSelectedCustomerForStage] = useState<CustomerResponse | null>(null);
  const [targetStage, setTargetStage] = useState<string>('');
  const [stageNote, setStageNote] = useState<string>('');
  const [updatingStage, setUpdatingStage] = useState<boolean>(false);
  const [stageNotification, setStageNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

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

      // Cập nhật số lượng khách cần chốt gấp nếu đang ở danh sách tổng
      if (Array.isArray(json.data)) {
        const uCount = json.data.filter((c: CustomerResponse) => Boolean(c.urgency_reason)).length;
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
    fetchCustomers();
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
      const res = await fetch(`/api/customers/${selectedCustomerForStage.id}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage: targetStage,
          note: stageNote.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.message || 'Lỗi khi cập nhật trạng thái.');
      }

      // Cập nhật trạng thái khách hàng trong danh sách local
      setCustomers((prev) =>
        prev.map((c) =>
          c.id === selectedCustomerForStage.id
            ? { ...c, stage: targetStage as any }
            : c
        )
      );

      setStageNotification({
        type: 'success',
        message: `Đã cập nhật giai đoạn khách hàng sang [${targetStage}] thành công!`,
      });

      setTimeout(() => {
        setSelectedCustomerForStage(null);
        setStageNotification(null);
        fetchCustomers();
      }, 900);
    } catch (err: unknown) {
      setStageNotification({
        type: 'error',
        message: err instanceof Error ? err.message : 'Lỗi khi cập nhật.',
      });
    } finally {
      setUpdatingStage(false);
    }
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
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

      // Clear form on success
      setFormData({
        name: '',
        phone: '',
        source: 'MANUAL',
        channel: '',
        external_id: '',
      });

      // Refresh list
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800 p-5 rounded-2xl backdrop-blur">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-3">
            <span>Danh Sách Khách Hàng</span>
            <span className="text-xs px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 font-medium">
              Customer 360
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Quản lý tập trung hồ sơ, danh tính đa kênh và hành trình khách hàng toàn diện.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Privacy Indicator Badge */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-mono">
            {isSale ? (
              <span className="flex items-center gap-1.5 text-amber-400 border-amber-800/40 bg-amber-950/30 px-2 py-1 rounded-lg">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Zero-Phone (Masked: 09******12)
              </span>
            ) : isBossAdmin ? (
              <span className="flex items-center gap-1.5 text-emerald-400 border-emerald-800/40 bg-emerald-950/30 px-2 py-1 rounded-lg">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                Quản trị viên (Số thật & Audit Log)
              </span>
            ) : null}
          </div>

          <button
            onClick={() => setIsModalOpen(true)}
            id="add-customer-btn"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-semibold shadow-lg shadow-blue-500/20 transition-all active:scale-95"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            <span>Thêm khách hàng</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs: Tất cả vs Hàng chờ CẦN SALE CHỐT */}
      <div className="flex items-center gap-2 border-b border-slate-800 pb-2">
        <button
          type="button"
          onClick={() => {
            setActiveTab('ALL');
            setPage(1);
          }}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition ${
            activeTab === 'ALL'
              ? 'bg-slate-800 text-white shadow-sm border border-slate-700'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          <span>Tất cả khách hàng</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('URGENT_CLOSING');
            setPage(1);
          }}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition relative ${
            activeTab === 'URGENT_CLOSING'
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
              : 'text-slate-400 hover:text-amber-300 hover:bg-amber-500/10'
          }`}
        >
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          </span>
          <span className="font-semibold">⚡ CẦN SALE CHỐT</span>
          {urgentCount > 0 && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-amber-500 text-slate-950 font-bold ml-1">
              {urgentCount}
            </span>
          )}
        </button>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          {/* Search Box */}
          <div className="md:col-span-2">
            <form onSubmit={handleSearchSubmit} className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm kiếm theo tên khách hoặc mã KH-xxxxxx..."
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition"
              />
              <svg
                className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
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
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition"
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
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition"
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
          <div className="flex items-center justify-between text-xs text-slate-400 pt-2 border-t border-slate-800">
            <div className="flex items-center gap-2">
              <span>Đang lọc:</span>
              {search && <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200">Từ khóa: &quot;{search}&quot;</span>}
              {selectedSource && <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200">Nguồn: {SOURCE_LABELS[selectedSource]?.label || selectedSource}</span>}
              {selectedStage && <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200">Giai đoạn: {STAGE_LABELS[selectedStage]?.label || selectedStage}</span>}
            </div>
            <button
              onClick={handleResetFilters}
              className="text-blue-400 hover:text-blue-300 transition font-medium"
            >
              Đặt lại bộ lọc
            </button>
          </div>
        )}
      </div>

      {/* Table & Content Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        {loading ? (
          <div className="p-8 space-y-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 bg-slate-800/50 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <div className="p-12 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-rose-500/20 text-rose-400 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p className="text-white font-medium">{error}</p>
            <button
              onClick={() => fetchCustomers()}
              className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-white transition"
            >
              Thử lại
            </button>
          </div>
        ) : customers.length === 0 ? (
          <div className="p-16 text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-slate-800/80 text-slate-400 flex items-center justify-center mx-auto border border-slate-700">
              <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Chưa có khách hàng nào</h3>
              <p className="text-sm text-slate-400 mt-1">
                Không tìm thấy dữ liệu phù hợp với điều kiện tìm kiếm hiện tại.
              </p>
            </div>
            {(search || selectedSource || selectedStage) && (
              <button
                onClick={handleResetFilters}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm text-blue-400 border border-slate-700 transition"
              >
                Xóa toàn bộ bộ lọc
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 text-xs font-semibold uppercase tracking-wider">
                  <th className="py-3.5 px-4">Mã KH</th>
                  <th className="py-3.5 px-4">Họ và Tên</th>
                  <th className="py-3.5 px-4">Số điện thoại</th>
                  <th className="py-3.5 px-4">Nguồn tiếp nhận</th>
                  <th className="py-3.5 px-4">Giai đoạn</th>
                  <th className="py-3.5 px-4">Ngày tạo</th>
                  <th className="py-3.5 px-4 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-sm">
                {customers.map((c) => {
                  const sourceConfig = SOURCE_LABELS[c.source] || SOURCE_LABELS.MANUAL;
                  const stageConfig = STAGE_LABELS[c.stage] || {
                    label: c.stage,
                    color: 'text-slate-300',
                    border: 'border-slate-700',
                    bg: 'bg-slate-800',
                  };

                  return (
                    <tr
                      key={c.id}
                      className="hover:bg-slate-800/40 transition group cursor-pointer"
                    >
                      {/* Customer Code */}
                      <td className="py-3.5 px-4">
                        <Link
                          href={`/customers/${c.id}`}
                          className="font-mono text-xs font-semibold px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-blue-400 hover:border-blue-500 transition inline-block"
                        >
                          {c.customer_code}
                        </Link>
                      </td>

                      {/* Name */}
                      <td className="py-3.5 px-4">
                        <Link
                          href={`/customers/${c.id}`}
                          className="font-medium text-white hover:text-blue-300 transition"
                        >
                          {c.name}
                        </Link>
                      </td>

                      {/* Phone (Masked or Unmasked) */}
                      <td className="py-3.5 px-4">
                        {c.phone ? (
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center gap-1.5 font-mono text-xs px-2.5 py-1 rounded-md border ${
                                c.is_phone_masked
                                  ? 'bg-amber-950/30 border-amber-800/40 text-amber-300'
                                  : 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300'
                              }`}
                            >
                              {c.is_phone_masked && (
                                <svg className="w-3 h-3 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                              )}
                              {c.phone}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-500 italic text-xs">Chưa có số</span>
                        )}
                      </td>

                      {/* Source */}
                      <td className="py-3.5 px-4">
                        <span
                          className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium border ${sourceConfig.bg} ${sourceConfig.border} ${sourceConfig.color}`}
                        >
                          {sourceConfig.label}
                        </span>
                      </td>

                      {/* Stage & Urgency Badge */}
                      <td className="py-3.5 px-4">
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium border ${stageConfig.bg} ${stageConfig.border} ${stageConfig.color}`}
                          >
                            {stageConfig.label}
                          </span>
                          {c.urgency_reason && (
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border ${
                                c.urgency_reason === 'PRICE_OFFERED'
                                  ? 'bg-teal-500/20 text-teal-300 border-teal-500/40'
                                  : c.urgency_reason === 'NEGOTIATING'
                                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                  : 'bg-rose-500/20 text-rose-300 border-rose-500/40 animate-pulse'
                              }`}
                            >
                              <span>⚡</span>
                              <span>
                                {c.urgency_label ||
                                  (c.urgency_reason === 'PRICE_OFFERED'
                                    ? 'Đã có giá'
                                    : c.urgency_reason === 'NEGOTIATING'
                                    ? 'Đang thương lượng'
                                    : 'Khách phản hồi')}
                              </span>
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Created At */}
                      <td className="py-3.5 px-4 text-xs text-slate-400">
                        {new Date(c.created_at).toLocaleString('vi-VN', {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedCustomerForStage(c);
                              setTargetStage(c.stage);
                              setStageNote('');
                              setStageNotification(null);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-indigo-600/20 hover:bg-indigo-600 border border-indigo-500/30 text-indigo-300 hover:text-white text-xs font-medium transition"
                            title="Cập nhật giai đoạn vòng đời khách hàng"
                          >
                            Đổi trạng thái
                          </button>
                          <Link
                            href={`/inbox?customer_id=${c.id}`}
                            className="p-1.5 rounded-lg bg-blue-600/10 hover:bg-blue-600 border border-blue-500/20 text-blue-400 hover:text-white text-xs transition"
                            title="Mở Hộp thư Chat"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                          </Link>
                          <Link
                            href={`/customers/${c.id}`}
                            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-xs font-medium transition"
                          >
                            Hồ sơ 360
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        {!loading && customers.length > 0 && (
          <div className="p-4 border-t border-slate-800 bg-slate-950/40 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-400">
            <div>
              Hiển thị <span className="font-semibold text-white">{(page - 1) * limit + 1}</span> -{' '}
              <span className="font-semibold text-white">
                {Math.min(page * limit, total)}
              </span>{' '}
              trên tổng số <span className="font-semibold text-white">{total}</span> khách hàng
            </div>

            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(p - 1, 1))}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition border border-slate-700"
              >
                Trang trước
              </button>
              <span className="px-2 py-1 font-mono text-slate-300">
                {page} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition border border-slate-700"
              >
                Trang sau
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Modal Thêm / Gộp Khách Hàng */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700/80 w-full max-w-lg rounded-2xl p-6 shadow-2xl space-y-5 text-white">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <span>Tiếp Nhận Khách Hàng Mới</span>
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {formNotification && (
              <div
                className={`p-3 rounded-xl text-sm border flex items-center gap-2 ${
                  formNotification.type === 'success'
                    ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-300'
                    : 'bg-rose-950/40 border-rose-700/50 text-rose-300'
                }`}
              >
                <span>{formNotification.message}</span>
              </div>
            )}

            <form onSubmit={handleCreateCustomer} className="space-y-4 text-sm">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Họ và tên khách hàng <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ví dụ: Anh Tuấn - Cầu Giấy"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Số điện thoại <span className="text-rose-400">*</span>
                </label>
                <input
                  type="tel"
                  required
                  placeholder="Ví dụ: 0912345678 hoặc +84912345678"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 font-mono"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Số điện thoại được dùng làm khóa chính để tự động gộp khách hàng trùng lặp.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Nguồn tiếp nhận
                  </label>
                  <select
                    value={formData.source}
                    onChange={(e) => setFormData({ ...formData, source: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  >
                    <option value="MANUAL">Nhập thủ công</option>
                    <option value="HOTLINE">Hotline</option>
                    <option value="FACEBOOK">Facebook Fanpage</option>
                    <option value="ZALO">Zalo OA</option>
                    <option value="WEBSITE">Website</option>
                    <option value="ADVERTISING">Quảng cáo</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Liên kết kênh xã hội
                  </label>
                  <select
                    value={formData.channel}
                    onChange={(e) => setFormData({ ...formData, channel: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  >
                    <option value="">Không liên kết</option>
                    <option value="ZALO">Zalo UID</option>
                    <option value="FACEBOOK">Facebook PSID</option>
                    <option value="WEBSITE">Website Session</option>
                  </select>
                </div>
              </div>

              {formData.channel && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    Mã định danh bên ngoài ({formData.channel} ID)
                  </label>
                  <input
                    type="text"
                    placeholder="Nhập UID hoặc ID kênh bên ngoài..."
                    value={formData.external_id}
                    onChange={(e) => setFormData({ ...formData, external_id: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 font-mono"
                  />
                </div>
              )}

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition flex items-center gap-2"
                >
                  {submitting ? 'Đang lưu...' : 'Lưu khách hàng'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Cập Nhật Trạng Thái Vòng Đời Khách Hàng */}
      {selectedCustomerForStage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-700/80 w-full max-w-md rounded-2xl p-6 shadow-2xl space-y-5 text-white">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <span>Chuyển Giai Đoạn Khách Hàng</span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5 font-mono">
                  {selectedCustomerForStage.customer_code} • {selectedCustomerForStage.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCustomerForStage(null)}
                className="text-slate-400 hover:text-white transition p-1 rounded-lg hover:bg-slate-800"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {stageNotification && (
              <div
                className={`p-3 rounded-xl text-sm border flex items-center gap-2 ${
                  stageNotification.type === 'success'
                    ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-300'
                    : 'bg-rose-950/40 border-rose-700/50 text-rose-300'
                }`}
              >
                <span>{stageNotification.message}</span>
              </div>
            )}

            <form onSubmit={handleUpdateStageSubmit} className="space-y-4 text-sm">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Giai đoạn hiện tại
                </label>
                <div className="text-xs font-mono px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-slate-400">
                  {STAGE_LABELS[selectedCustomerForStage.stage]?.label || selectedCustomerForStage.stage}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Chuyển sang giai đoạn mới <span className="text-rose-400">*</span>
                </label>
                <select
                  value={targetStage}
                  onChange={(e) => setTargetStage(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  required
                >
                  <option value="" disabled>-- Chọn giai đoạn --</option>
                  {Object.entries(STAGE_LABELS).map(([val, info]) => (
                    <option key={val} value={val}>
                      {info.label} ({val})
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  Mỗi lần đổi trạng thái sẽ được ghi nhận vào bảng customer_stage_histories (Strict Append-Only).
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Lý do / Ghi chú chuyển đổi
                </label>
                <textarea
                  rows={3}
                  value={stageNote}
                  onChange={(e) => setStageNote(e.target.value)}
                  placeholder="Ví dụ: Đã gửi báo giá sơ bộ qua Zalo cho khách; khách hẹn chiều mai phản hồi chốt lịch..."
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 text-sm"
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setSelectedCustomerForStage(null)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  disabled={updatingStage || !targetStage || targetStage === selectedCustomerForStage.stage}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 text-white text-sm font-semibold transition flex items-center gap-2"
                >
                  {updatingStage ? 'Đang lưu...' : 'Xác nhận đổi giai đoạn'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
