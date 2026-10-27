'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { revealCustomerPhoneAction } from '../../../app/actions/sensitive';

interface PhoneRevealContextType {
  activeCustomerId: string | null;
  revealedPhone: string | null;
  loadingCustomerId: string | null;
  togglePhone: (customerId: string) => Promise<void>;
}

const PhoneRevealContext = createContext<PhoneRevealContextType>({
  activeCustomerId: null,
  revealedPhone: null,
  loadingCustomerId: null,
  togglePhone: async () => {},
});

/**
 * Provider quản lý trạng thái hiển thị số điện thoại.
 * NGUYÊN TẮC BẢO MẬT TUYỆT ĐỐI:
 * 1. Khóa chặt (Mutex): Chỉ duy nhất 1 số điện thoại được hiển thị vào 1 thời điểm.
 * 2. Khi mở số điện thoại thứ 2, số điện thoại thứ 1 sẽ lập tức bị ẩn đi hoàn toàn.
 * 3. Chống sao chép (Anti-Copy): Số điện thoại được vẽ qua HTML5 Canvas bitmap,
 *    không có text node trong DOM, chặn copy/cut/drag/contextmenu và chặn phím tắt Ctrl+C / Cmd+C.
 */
export function PhoneRevealProvider({ children }: { children: React.ReactNode }) {
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(null);
  const [revealedPhone, setRevealedPhone] = useState<string | null>(null);
  const [loadingCustomerId, setLoadingCustomerId] = useState<string | null>(null);

  const togglePhone = useCallback(async (customerId: string) => {
    // Nếu bấm lại vào số đang mở -> đóng lại ngay lập tức
    if (activeCustomerId === customerId) {
      setActiveCustomerId(null);
      setRevealedPhone(null);
      setLoadingCustomerId(null);
      return;
    }

    // Chuyển sang khách hàng mới: LẬP TỨC ẩn số điện thoại cũ (Khóa đơn số)
    setActiveCustomerId(customerId);
    setRevealedPhone(null);
    setLoadingCustomerId(customerId);

    // Hủy bỏ mọi vùng chọn văn bản hiện hành trên màn hình
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges();
    }

    try {
      const res = await revealCustomerPhoneAction(customerId);
      if (res.success && res.phone) {
        setRevealedPhone(res.phone);
      } else {
        // Thất bại -> hoàn tác trạng thái
        setActiveCustomerId(null);
        setRevealedPhone(null);
      }
    } catch {
      setActiveCustomerId(null);
      setRevealedPhone(null);
    } finally {
      setLoadingCustomerId(null);
    }
  }, [activeCustomerId]);

  // Ngăn chặn sự kiện copy/cut và phím tắt sao chép khi đang hiển thị số điện thoại
  useEffect(() => {
    if (!activeCustomerId) return;

    const handleCopyCut = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.clipboardData) {
        e.clipboardData.clearData();
      }
      if (typeof window !== 'undefined') {
        window.getSelection()?.removeAllRanges();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Bắt các tổ hợp phím sao chép: Ctrl+C, Cmd+C, Ctrl+X, Cmd+X, Ctrl+Insert
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'c' || e.key === 'C' || e.key === 'x' || e.key === 'X' || e.key === 'Insert')
      ) {
        if (typeof window !== 'undefined') {
          window.getSelection()?.removeAllRanges();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    };

    document.addEventListener('copy', handleCopyCut, true);
    document.addEventListener('cut', handleCopyCut, true);
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      document.removeEventListener('copy', handleCopyCut, true);
      document.removeEventListener('cut', handleCopyCut, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [activeCustomerId]);

  return (
    <PhoneRevealContext.Provider
      value={{
        activeCustomerId,
        revealedPhone,
        loadingCustomerId,
        togglePhone,
      }}
    >
      {children}
    </PhoneRevealContext.Provider>
  );
}

export function usePhoneReveal() {
  return useContext(PhoneRevealContext);
}

/**
 * Component vẽ số điện thoại bằng Canvas thay vì text DOM.
 * Do số được vẽ dưới dạng pixel đồ họa trên thẻ <canvas>, trình duyệt HOÀN TOÀN KHÔNG CÓ text node
 * để người dùng có thể bôi đen, chọn chuột hoặc copy sang clipboard.
 */
function UncopyablePhoneCanvas({ phone }: { phone: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const fontSize = 12;
    const fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    const textMetrics = ctx.measureText(phone);
    const textWidth = Math.ceil(textMetrics.width);
    const textHeight = 18;

    canvas.width = (textWidth + 8) * dpr;
    canvas.height = textHeight * dpr;
    canvas.style.width = `${textWidth + 8}px`;
    canvas.style.height = `${textHeight}px`;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = `600 ${fontSize}px ${fontFamily}`;
    ctx.textBaseline = 'middle';

    // Nhận diện theme tối/sáng
    const isDark =
      typeof document !== 'undefined' &&
      (document.documentElement.classList.contains('dark') ||
        document.body.classList.contains('dark') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));

    ctx.fillStyle = isDark ? '#38bdf8' : '#0369a1';
    ctx.fillText(phone, 4, textHeight / 2);
  }, [phone]);

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/50 border border-sky-300 dark:border-sky-700 select-none cursor-default shadow-xs"
      style={{
        userSelect: 'none',
        WebkitUserSelect: 'none',
        MozUserSelect: 'none',
        msUserSelect: 'none',
      }}
      title="Số điện thoại được bảo vệ - Chống sao chép"
      onCopy={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.clipboardData?.clearData();
      }}
      onCut={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    >
      <ShieldCheck className="w-3 h-3 text-sky-600 dark:text-sky-400 shrink-0 select-none pointer-events-none" />
      <canvas
        ref={canvasRef}
        className="pointer-events-none select-none block"
        aria-hidden="true"
        tabIndex={-1}
      />
    </span>
  );
}

interface SecurePhoneRowProps {
  customerId: string;
  maskedPhone: string | null | undefined;
  className?: string;
}

/**
 * Hiển thị số điện thoại kèm nút con mắt.
 * - Trạng thái mặc định: Số đã bị mask (ví dụ: +843******55 hoặc 09******88).
 * - Bấm con mắt: Mở xem số điện thoại của liên hệ đó (đồng thời ẩn số của mọi liên hệ khác).
 * - Chống copy: Không thể bôi đen hay copy/paste số điện thoại.
 */
export function SecurePhoneRow({
  customerId,
  maskedPhone,
  className = '',
}: SecurePhoneRowProps) {
  const { activeCustomerId, revealedPhone, loadingCustomerId, togglePhone } = usePhoneReveal();

  if (!maskedPhone || maskedPhone === '—' || maskedPhone === 'Chưa xác định' || maskedPhone === 'Chưa cập nhật' || maskedPhone === 'Chưa có SĐT' || maskedPhone === 'Chưa có số') {
    return <span className="font-mono text-[var(--text-tertiary)] italic text-xs">{maskedPhone || '—'}</span>;
  }

  const isCurrentActive = activeCustomerId === customerId;
  const isLoading = loadingCustomerId === customerId;
  const isRevealed = isCurrentActive && Boolean(revealedPhone);

  return (
    <div
      className={`inline-flex items-center gap-1.5 select-none ${className}`}
      style={{
        userSelect: 'none',
        WebkitUserSelect: 'none',
        MozUserSelect: 'none',
        msUserSelect: 'none',
      }}
      onCopy={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.clipboardData?.clearData();
      }}
      onCut={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isRevealed && revealedPhone ? (
        <UncopyablePhoneCanvas phone={revealedPhone} />
      ) : (
        <span
          className="font-mono text-[var(--text-primary)] select-none"
          style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
        >
          {maskedPhone}
        </span>
      )}

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          togglePhone(customerId);
        }}
        disabled={isLoading}
        className={`p-1 rounded transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)] shrink-0 ${
          isRevealed
            ? 'text-sky-600 dark:text-sky-400 bg-sky-100 dark:bg-sky-900/50 hover:bg-sky-200'
            : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]'
        }`}
        title={
          isRevealed
            ? 'Bấm để ẩn số điện thoại'
            : 'Bấm để xem số điện thoại (Bảo mật: chỉ xem 1 số, chống sao chép)'
        }
        aria-label={isRevealed ? 'Ẩn số điện thoại' : 'Xem số điện thoại'}
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
        ) : isRevealed ? (
          <EyeOff className="w-3.5 h-3.5" />
        ) : (
          <Eye className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}

