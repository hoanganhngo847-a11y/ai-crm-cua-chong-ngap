'use client';

import { useEffect, useState } from 'react';

type Notice = { kind: 'loading' | 'error'; text: string } | null;

function getCustomerId(shell: Element): string | null {
  const link = shell.querySelector<HTMLAnchorElement>('a[href^="/calls/"]');
  if (!link) return null;
  const match = link.getAttribute('href')?.match(/^\/calls\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  return match?.[1] || null;
}

function isZaloPcControl(target: Element): boolean {
  const control = target.closest<HTMLElement>('button, [role="button"]');
  if (!control) return false;
  const label = `${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''} ${control.textContent || ''}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi-VN');
  return (
    label.includes('gọi qua zalo pc') ||
    label.includes('mở zalo pc để gọi video') ||
    label.includes('mở cuộc trò chuyện trên zalo pc') ||
    label.includes('mở đúng chat zalo để gọi') ||
    label.includes('mở đúng chat zalo để gọi video') ||
    label.includes('mở đúng cuộc trò chuyện zalo của khách để gọi') ||
    label.includes('mở đúng cuộc trò chuyện trên zalo')
  );
}

function messageFor(error: string | undefined): string {
  if (error === 'ZALO_PHONE_NOT_AVAILABLE') {
    return 'Zalo không trả số điện thoại cho UID này, nên CRM chưa thể mở chính xác cuộc chat trong Zalo PC.';
  }
  if (error === 'ZALO_PERSONAL_IDENTITY_NOT_FOUND') {
    return 'Khách này chưa có định danh Zalo cá nhân chính xác để mở trong Zalo PC.';
  }
  if (error === 'ZALO_PERSONAL_IDENTITY_CONFLICT') {
    return 'Khách này đang có xung đột định danh Zalo. CRM đã chặn mở để tránh nhảy nhầm người.';
  }
  return 'Không thể mở đúng cuộc chat trong Zalo PC lúc này. CRM đã không chuyển sang Zalo Web hoặc tìm theo tên.';
}

export default function ZaloPcCallInterceptor() {
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!isZaloPcControl(target)) return;

      const shell = target.closest('.platform-inbox-shell');
      if (!shell || shell.getAttribute('data-chat-channel') !== 'zalo') return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const customerId = getCustomerId(shell);
      if (!customerId) {
        setNotice({ kind: 'error', text: 'Không xác định được khách hàng đang mở. CRM đã chặn điều hướng để tránh mở nhầm Zalo.' });
        return;
      }

      setNotice({ kind: 'loading', text: 'Đang mở đúng cuộc chat trong Zalo PC…' });
      void (async () => {
        try {
          const response = await fetch(
            `/api/inbox/zalo-call-target?customer_id=${encodeURIComponent(customerId)}`,
            { cache: 'no-store' }
          );
          const body = (await response.json().catch(() => null)) as
            | { success?: unknown; error?: string; data?: { nativeReady?: unknown; launchUrl?: unknown } }
            | null;
          const launchUrl =
            body?.data && typeof body.data.launchUrl === 'string' ? body.data.launchUrl : '';

          if (!response.ok || body?.success !== true || body?.data?.nativeReady !== true || !launchUrl.startsWith('/api/inbox/zalo-pc-launch?')) {
            setNotice({ kind: 'error', text: messageFor(body?.error) });
            return;
          }

          window.location.assign(launchUrl);
          window.setTimeout(() => setNotice(null), 2500);
        } catch {
          setNotice({ kind: 'error', text: messageFor(undefined) });
        }
      })();
    };

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  if (!notice) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 10000,
        maxWidth: 420,
        borderRadius: 12,
        padding: '12px 14px',
        background: notice.kind === 'error' ? '#7f1d1d' : '#0f172a',
        color: '#fff',
        boxShadow: '0 10px 30px rgba(0,0,0,.22)',
        fontSize: 13,
        lineHeight: 1.45,
      }}
      onClick={() => notice.kind === 'error' && setNotice(null)}
    >
      {notice.text}
    </div>
  );
}
