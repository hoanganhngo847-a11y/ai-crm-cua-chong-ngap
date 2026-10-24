'use client';

import React, { useState, useTransition } from 'react';
import Link from 'next/link';
import type { ContractListItemDTO } from '../services';
import { getContractDownloadUrlAction, signContractAction } from '../actions';
import { PRODUCT_UPLOAD_MAX_BYTES } from '@/config/upload-policy';
import { Card } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ShieldCheck, AlertTriangle, Download, CheckCircle2 } from 'lucide-react';

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
    <div className="space-y-4">
      {/* AAL2 Warning Banner for BOSS_ADMIN without AAL2 */}
      {isBossAdmin && !hasAal2 && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-between gap-4 shadow-subtle">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-amber-900">Yêu cầu xác thực MFA AAL2</div>
              <p className="text-xs text-amber-700">
                Theo quy định bảo mật, thao tác Ký hợp đồng kinh tế bắt buộc tài khoản Quản trị viên (Boss) phải đạt cấp độ xác thực AAL2.
              </p>
            </div>
          </div>
          <Link
            href="/account"
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white transition whitespace-nowrap shadow-subtle"
          >
            Bật xác thực MFA &rarr;
          </Link>
        </div>
      )}

      {/* Toolbar */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)] uppercase tracking-wider">
              Lọc trạng thái:
            </span>
            <div className="flex gap-1.5">
              {[
                { id: 'ALL', label: 'Tất cả' },
                { id: 'SIGNED', label: 'Đã ký' },
                { id: 'UNSIGNED', label: 'Chưa ký' },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFilterStatus(f.id)}
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition cursor-pointer ${
                    filterStatus === f.id
                      ? 'bg-blue-600 text-white shadow-subtle'
                      : 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] border border-[var(--border-subtle)]'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            Tổng số: <strong className="text-[var(--text-primary)]">{filtered.length}</strong> hợp đồng
          </div>
        </div>
      </Card>

      {/* Contracts Table */}
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[130px]">Mã Đơn / HĐ</TableHead>
              <TableHead className="text-center w-[90px]">Phiên Bản</TableHead>
              <TableHead>Khách Hàng</TableHead>
              <TableHead className="text-right">Tổng Tiền (VNĐ)</TableHead>
              <TableHead className="text-right">Công Nợ Còn Lại</TableHead>
              <TableHead className="text-center">Trạng Thái Ký</TableHead>
              <TableHead className="text-center">Trạng Thái HĐ</TableHead>
              <TableHead className="text-center">Tác Vụ Hợp Đồng</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((contract) => {
              const isDownloadingGen = downloadingId === `${contract.id}_generated`;
              const isDownloadingSigned = downloadingId === `${contract.id}_signed`;

              return (
                <TableRow key={contract.id}>
                  {/* Mã đơn */}
                  <TableCell className="font-mono text-xs font-semibold text-blue-600">
                    <span title={contract.id}>{contract.orderCode}</span>
                  </TableCell>

                  {/* Phiên bản */}
                  <TableCell className="text-center text-xs font-mono text-[var(--text-secondary)]">
                    Rev {contract.revisionNo}
                  </TableCell>

                  {/* Khách hàng */}
                  <TableCell className="font-medium text-[var(--text-primary)]">
                    {contract.customerName}
                  </TableCell>

                  {/* Tổng tiền */}
                  <TableCell className="text-right font-medium text-[var(--text-primary)]">
                    {contract.contractValue.toLocaleString('vi-VN')}
                  </TableCell>

                  {/* Công nợ còn lại */}
                  <TableCell className="text-right text-xs font-semibold text-rose-600">
                    {contract.receivableAmount.toLocaleString('vi-VN')}
                  </TableCell>

                  {/* Trạng thái ký */}
                  <TableCell className="text-center">
                    {contract.isSigned ? (
                      <Badge variant="success" size="sm">
                        ĐÃ KÝ
                      </Badge>
                    ) : (
                      <Badge variant="warning" size="sm">
                        CHƯA KÝ
                      </Badge>
                    )}
                  </TableCell>

                  {/* Trạng thái HĐ */}
                  <TableCell className="text-center">
                    <Badge variant="neutral" size="sm" className="font-mono">
                      {contract.status || 'DRAFT'}
                    </Badge>
                  </TableCell>

                  {/* Tác vụ */}
                  <TableCell className="text-center">
                    <div className="flex items-center justify-center gap-1.5 flex-wrap">
                      {/* Tải bản nháp PDF */}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleDownload(contract.id, 'generated')}
                        disabled={isDownloadingGen}
                        leftIcon={<Download className="w-3.5 h-3.5" />}
                        className="text-xs"
                      >
                        {isDownloadingGen ? 'Đang mở...' : 'HĐ Nháp'}
                      </Button>

                      {/* Nếu đã ký -> Tải bản ký */}
                      {contract.isSigned && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDownload(contract.id, 'signed')}
                          disabled={isDownloadingSigned}
                          leftIcon={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                          className="text-xs text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                        >
                          {isDownloadingSigned ? 'Đang mở...' : 'Bản Ký'}
                        </Button>
                      )}

                      {/* Nếu chưa ký & BOSS_ADMIN */}
                      {!contract.isSigned && isBossAdmin && (
                        hasAal2 ? (
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleOpenSignModal(contract)}
                            className="text-xs bg-amber-600 hover:bg-amber-700"
                          >
                            Ký duyệt HĐ
                          </Button>
                        ) : (
                          <span
                            className="px-2 py-1 rounded-md bg-amber-50 text-[11px] text-amber-700 border border-amber-200 cursor-help font-medium"
                            title="Yêu cầu MFA cấp độ AAL2 để ký hợp đồng"
                          >
                            Cần AAL2
                          </span>
                        )
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}

            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-[var(--text-tertiary)]">
                  Chưa có dữ liệu hợp đồng nào phù hợp bộ lọc.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Signing Modal (BOSS_ADMIN ONLY + AAL2) */}
      {selectedContract && isBossAdmin && hasAal2 && (
        <Modal
          isOpen={true}
          onClose={() => setSelectedContract(null)}
          title="Ký & Phê duyệt Hợp đồng chính thức"
          size="md"
        >
          <div className="space-y-4">
            <div className="bg-[var(--surface-secondary)] p-3 rounded-lg border border-[var(--border-subtle)] text-xs space-y-1.5">
              <div>
                Mã đơn hàng: <strong className="text-blue-600 font-mono">{selectedContract.orderCode}</strong>
              </div>
              <div>
                Khách hàng: <strong className="text-[var(--text-primary)]">{selectedContract.customerName}</strong>
              </div>
              <div>
                Giá trị hợp đồng: <strong>{selectedContract.contractValue.toLocaleString('vi-VN')} VNĐ</strong>
              </div>
              <div>
                Phiên bản: <strong className="text-[var(--text-secondary)]">Revision {selectedContract.revisionNo}</strong>
              </div>
              <div className="text-[11px] text-emerald-700 font-medium flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 inline" />
                Xác thực danh tính: {userRole} (MFA AAL2 ĐÃ XÁC THỰC)
              </div>
            </div>

            <form onSubmit={handleSignSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--text-primary)] mb-1">
                  Chọn tệp PDF hợp đồng đã ký (Tối đa 10MB) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="file"
                  accept="application/pdf"
                  required
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  className="w-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)] rounded-lg p-2 text-xs text-[var(--text-primary)] file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer"
                />
                <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
                  Đường dẫn lưu trữ và phiên bản revision được máy chủ tính toán tự động. Không thể ghi đè tùy tiện.
                </p>
              </div>

              {feedback && (
                <div
                  className={`p-3 rounded-lg text-xs ${
                    feedback.type === 'success'
                      ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border border-rose-200 text-rose-800'
                  }`}
                >
                  {feedback.message}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectedContract(null)}
                  disabled={signingId !== null}
                >
                  Hủy
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={signingId !== null || !selectedFile}
                  isLoading={signingId !== null}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  Ký & Phê duyệt HĐ
                </Button>
              </div>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}
