'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import type { ContractListItemDTO } from '../services';
import { getContractDownloadUrlAction, signContractAction } from '../actions';
import { PRODUCT_UPLOAD_MAX_BYTES } from '@/config/upload-policy';

interface ContractsViewProps {
  contracts: ContractListItemDTO[];
  userRole: string;
  userAal?: string | null;
}

export default function ContractsView({ contracts, userRole, userAal }: ContractsViewProps) {
  const isBossAdmin = userRole === 'BOSS_ADMIN';
  const hasAal2 = userAal === 'aal2';

  const [selectedContract, setSelectedContract] = useState<ContractListItemDTO | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [isPending, startTransition] = useTransition();

  const handleDownload = async (contractId: string, variant: 'generated' | 'signed') => {
    try {
      setDownloadingId(`${contractId}_${variant}`);
      const res = await getContractDownloadUrlAction({ contractId, variant });
      if (res.success && res.signedUrl) {
        window.open(res.signedUrl, '_blank');
      } else {
        alert(res.error || 'Không thể tạo liên kết tải hợp đồng.');
      }
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Lỗi tải xuống hợp đồng.');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleOpenSignModal = (contract: ContractListItemDTO) => {
    setSelectedContract(contract);
    setSelectedFile(null);
    setFeedback(null);
  };

  const handleSignSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedContract || !selectedFile || signingId || isPending) return;

    if (!selectedFile.name.toLowerCase().endsWith('.pdf')) {
      setFeedback({ type: 'error', message: 'Tệp ký phải có định dạng .pdf' });
      return;
    }

    if (selectedFile.size > PRODUCT_UPLOAD_MAX_BYTES) {
      setFeedback({ type: 'error', message: 'Dung lượng tệp ký vượt quá 10MB.' });
      return;
    }

    setSigningId(selectedContract.id);
    setFeedback(null);

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.append('contractId', selectedContract.id);
        formData.append('file', selectedFile);

        const res = await signContractAction(formData);
        if (res.success) {
          setFeedback({
            type: 'success',
            message: 'Ký và phê duyệt hợp đồng thành công! Đơn hàng đã sẵn sàng xuất xưởng sản xuất.',
          });
          setTimeout(() => {
            setSelectedContract(null);
          }, 1500);
        } else {
          setFeedback({
            type: 'error',
            message: res.error || 'Lỗi khi ký hợp đồng.',
          });
        }
      } catch (err: unknown) {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : 'Lỗi hệ thống khi ký hợp đồng.',
        });
      } finally {
        setSigningId(null);
      }
    });
  };

  const filtered = contracts.filter((c) => {
    if (filterStatus === 'ALL') return true;
    if (filterStatus === 'SIGNED') return c.isSigned;
    if (filterStatus === 'UNSIGNED') return !c.isSigned;
    return c.status === filterStatus;
  });

  return (
    <div className="space-y-6">
      {/* Header Notification if Boss without AAL2 */}
      {isBossAdmin && !hasAal2 && (
        <div className="p-4 bg-amber-950/50 border border-amber-800 rounded-xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">⚠️</span>
            <div>
              <div className="text-sm font-bold text-amber-300">Yêu cầu xác thực MFA AAL2</div>
              <p className="text-xs text-slate-300">
                Theo quy định bảo mật, thao tác Ký hợp đồng kinh tế bắt buộc tài khoản Quản trị viên (Boss) phải đạt cấp độ xác thực AAL2.
              </p>
            </div>
          </div>
          <Link
            href="/account"
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition whitespace-nowrap"
          >
            Bật xác thực MFA &rarr;
          </Link>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Lọc trạng thái:</span>
          <div className="flex gap-1.5">
            {[
              { id: 'ALL', label: 'Tất cả' },
              { id: 'SIGNED', label: 'Đã ký' },
              { id: 'UNSIGNED', label: 'Chưa ký' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setFilterStatus(f.id)}
                className={`px-3 py-1 text-xs rounded-lg font-medium transition ${
                  filterStatus === f.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="text-xs text-slate-400">
          Tổng số: <strong className="text-white">{filtered.length}</strong> hợp đồng
        </div>
      </div>

      {/* Contracts Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 shadow">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/60 text-slate-400 text-xs uppercase font-medium">
            <tr>
              <th className="py-3 px-4 text-left">Mã Đơn / Hợp Đồng</th>
              <th className="py-3 px-4 text-center">Phiên Bản</th>
              <th className="py-3 px-4 text-left">Khách Hàng</th>
              <th className="py-3 px-4 text-right">Tổng Tiền (VNĐ)</th>
              <th className="py-3 px-4 text-right">Công Nợ Còn Lại</th>
              <th className="py-3 px-4 text-center">Trạng Thái Ký</th>
              <th className="py-3 px-4 text-center">Trạng Thái HĐ</th>
              <th className="py-3 px-4 text-center">Tác Vụ Hợp Đồng</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filtered.map((contract) => {
              const isDownloadingGen = downloadingId === `${contract.id}_generated`;
              const isDownloadingSigned = downloadingId === `${contract.id}_signed`;

              return (
                <tr key={contract.id} className="hover:bg-slate-800/40 transition">
                  {/* Mã đơn */}
                  <td className="py-3 px-4 font-mono text-xs font-semibold text-blue-400">
                    <span title={contract.id}>{contract.orderCode}</span>
                  </td>

                  {/* Phiên bản */}
                  <td className="py-3 px-4 text-center text-xs font-mono text-slate-400">
                    Rev {contract.revisionNo}
                  </td>

                  {/* Khách hàng */}
                  <td className="py-3 px-4 font-medium text-white">
                    {contract.customerName}
                  </td>

                  {/* Tổng tiền */}
                  <td className="py-3 px-4 text-right font-medium text-slate-200">
                    {contract.contractValue.toLocaleString('vi-VN')}
                  </td>

                  {/* Công nợ còn lại */}
                  <td className="py-3 px-4 text-right text-xs font-bold text-rose-400">
                    {contract.receivableAmount.toLocaleString('vi-VN')}
                  </td>

                  {/* Trạng thái ký */}
                  <td className="py-3 px-4 text-center">
                    {contract.isSigned ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-950/70 border border-emerald-800 text-emerald-300">
                        ĐÃ KÝ
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-950/70 border border-amber-800 text-amber-300">
                        CHƯA KÝ
                      </span>
                    )}
                  </td>

                  {/* Trạng thái HĐ */}
                  <td className="py-3 px-4 text-center">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-slate-800 text-slate-300">
                      {contract.status || 'DRAFT'}
                    </span>
                  </td>

                  {/* Tác vụ */}
                  <td className="py-3 px-4 text-center">
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      {/* Tải bản nháp PDF */}
                      <button
                        onClick={() => handleDownload(contract.id, 'generated')}
                        disabled={isDownloadingGen}
                        className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-blue-300 hover:text-blue-200 border border-slate-700 transition"
                      >
                        {isDownloadingGen ? 'Đang mở...' : 'Tải HĐ Nháp'}
                      </button>

                      {/* Nếu đã ký -> Tải bản ký */}
                      {contract.isSigned && (
                        <button
                          onClick={() => handleDownload(contract.id, 'signed')}
                          disabled={isDownloadingSigned}
                          className="px-2.5 py-1 rounded bg-emerald-950/60 hover:bg-emerald-900/60 text-xs font-medium text-emerald-300 border border-emerald-800 transition"
                        >
                          {isDownloadingSigned ? 'Đang mở...' : 'Tải Bản Ký'}
                        </button>
                      )}

                      {/* Nếu chưa ký & BOSS_ADMIN */}
                      {!contract.isSigned && isBossAdmin && (
                        hasAal2 ? (
                          <button
                            onClick={() => handleOpenSignModal(contract)}
                            className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-xs font-bold text-white transition shadow-sm"
                          >
                            Ký duyệt HĐ
                          </button>
                        ) : (
                          <span
                            className="px-2 py-1 rounded bg-slate-800 text-[11px] text-amber-400/80 border border-amber-800/40 cursor-help"
                            title="Yêu cầu MFA cấp độ AAL2 để ký hợp đồng"
                          >
                            Cần AAL2
                          </span>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-10 text-center text-slate-500">
                  Chưa có dữ liệu hợp đồng nào phù hợp bộ lọc.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Signing Modal (BOSS_ADMIN ONLY + AAL2) */}
      {selectedContract && isBossAdmin && hasAal2 && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-lg font-bold text-white">Ký &amp; Phê duyệt Hợp đồng chính thức</h3>
              <button
                onClick={() => setSelectedContract(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800/80 text-xs space-y-1.5">
              <div>
                Mã đơn hàng: <strong className="text-blue-400 font-mono">{selectedContract.orderCode}</strong>
              </div>
              <div>
                Khách hàng: <strong className="text-white">{selectedContract.customerName}</strong>
              </div>
              <div>
                Giá trị hợp đồng: <strong>{selectedContract.contractValue.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
              <div>
                Phiên bản: <strong className="text-slate-300">Revision {selectedContract.revisionNo}</strong>
              </div>
              <div className="text-[11px] text-emerald-400 font-mono">
                Xác thực danh tính: {userRole} (MFA AAL2 ĐÃ XÁC THỰC)
              </div>
            </div>

            <form onSubmit={handleSignSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Chọn tệp PDF hợp đồng đã ký (Tối đa 10MB) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="file"
                  accept="application/pdf"
                  required
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-slate-300 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-500 cursor-pointer"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Đường dẫn lưu trữ và phiên bản revision được máy chủ tính toán tự động. Không thể ghi đè tùy tiện.
                </p>
              </div>

              {feedback && (
                <div
                  className={`p-3 rounded-lg text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-950/80 border border-emerald-800 text-emerald-300'
                      : 'bg-rose-950/80 border border-rose-800 text-rose-300'
                  }`}
                >
                  {feedback.message}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setSelectedContract(null)}
                  disabled={signingId !== null}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={signingId !== null || !selectedFile}
                  className="px-4 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white transition disabled:opacity-50"
                >
                  {signingId ? 'Đang xác thực & lưu trữ...' : 'Ký & Phê duyệt HĐ'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
