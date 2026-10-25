'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Info,
  Link2,
  PanelRightClose,
  PanelRightOpen,
  Phone,
  Search,
  Video,
} from 'lucide-react';
import InboxView from './inbox-view';
import { buildZaloHandoffTarget, normalizeZaloPhone } from '../utils/zalo-handoff';
import './platform-inbox-shell.css';

interface PlatformInboxShellProps {
  userRole?: string | null;
  userFullName?: string | null;
  initialCustomerId?: string | null;
}

type NativeChannel = 'zalo' | 'facebook' | 'none';

type HandoffNotice = {
  mode: 'audio' | 'video';
  targeted: boolean;
  fallbackUrl: string | null;
  targetKind: 'phone' | 'uid' | 'none';
} | null;

const CUSTOMER_CALL_HREF_REGEX = /^\/calls\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function customerIdFromCallHref(href: string | null): string | null {
  if (!href) return null;
  return href.match(CUSTOMER_CALL_HREF_REGEX)?.[1] || null;
}

function IconButton({
  title,
  onClick,
  disabled = false,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="platform-native-icon-button"
    >
      {children}
    </button>
  );
}

export default function PlatformInboxShell({
  userRole,
  userFullName,
  initialCustomerId,
}: PlatformInboxShellProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [channel, setChannel] = useState<NativeChannel>('none');
  const [callHref, setCallHref] = useState<string | null>(null);
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  const [contextHost, setContextHost] = useState<HTMLElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMatches, setSearchMatches] = useState(0);
  const [mediaCount, setMediaCount] = useState(0);
  const [fileCount, setFileCount] = useState(0);
  const [linkCount, setLinkCount] = useState(0);
  const [handoffNotice, setHandoffNotice] = useState<HandoffNotice>(null);
  const [zaloTargetLoading, setZaloTargetLoading] = useState(false);

  const getWorkspaceParts = useCallback(() => {
    const root = shellRef.current?.firstElementChild as HTMLElement | null;
    if (!root) return null;
    const workspace = Array.from(root.children).find((element) =>
      (element as HTMLElement).className?.toString().includes('grid-cols-1')
    ) as HTMLElement | undefined;
    if (!workspace || workspace.children.length < 2) return null;

    const center = workspace.children[1] as HTMLElement;
    const right = workspace.children[2] as HTMLElement | undefined;
    const header = center.firstElementChild as HTMLElement | null;
    const actions = header?.lastElementChild as HTMLElement | null;
    return { root, workspace, center, right, header, actions };
  }, []);

  const extractVisiblePhone = useCallback(() => {
    const scope = shellRef.current;
    if (!scope) return null;

    const candidates = Array.from(scope.querySelectorAll('span'));
    const phoneLabel = candidates.find(
      (element) => element.textContent?.trim().toLowerCase() === 'số điện thoại:'
    );
    const row = phoneLabel?.parentElement;
    if (!row) return null;
    const value = row.lastElementChild?.textContent?.trim() || '';
    return normalizeZaloPhone(value);
  }, []);

  const refreshDomBinding = useCallback(() => {
    const parts = getWorkspaceParts();
    if (!parts?.header) return;

    const headerText = parts.header.textContent || '';
    const nextChannel: NativeChannel = headerText.includes('Zalo OA')
      ? 'zalo'
      : headerText.includes('Facebook')
        ? 'facebook'
        : 'none';
    setChannel((current) => (current === nextChannel ? current : nextChannel));

    const callLink = parts.header.querySelector<HTMLAnchorElement>('a[href^="/calls/"]');
    setCallHref(callLink?.getAttribute('href') || null);
    if (callLink) {
      callLink.dataset.nativeCallLink = 'true';
      callLink.title =
        nextChannel === 'zalo'
          ? 'Mở đúng cuộc trò chuyện Zalo của khách để gọi'
          : 'Gọi khách';
    }

    if (parts.actions) {
      parts.actions.classList.add('platform-native-header-actions');
      let host = parts.actions.querySelector<HTMLElement>('[data-platform-header-host="true"]');
      if (!host) {
        host = document.createElement('div');
        host.dataset.platformHeaderHost = 'true';
        host.className = 'platform-native-header-host';
        parts.actions.appendChild(host);
      }
      setHeaderHost((current) => (current === host ? current : host));
    }

    if (parts.right) {
      parts.right.dataset.platformContextColumn = 'true';
      let host = parts.right.querySelector<HTMLElement>('[data-platform-context-host="true"]');
      if (!host) {
        host = document.createElement('div');
        host.dataset.platformContextHost = 'true';
        host.className = 'platform-native-context-host';
        parts.right.prepend(host);
      }
      setContextHost((current) => (current === host ? current : host));
    }

    const center = parts.center;
    const images = center.querySelectorAll('img').length;
    const anchors = Array.from(center.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const files = anchors.filter((anchor) =>
      /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv)(?:$|[?#])/i.test(anchor.href)
    ).length;
    const links = anchors.filter(
      (anchor) =>
        /^https?:/i.test(anchor.href) &&
        !/\.(?:png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv)(?:$|[?#])/i.test(anchor.href)
    ).length;
    setMediaCount(images);
    setFileCount(files);
    setLinkCount(links);
  }, [getWorkspaceParts]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refreshDomBinding);
    };
    schedule();

    const observer = new MutationObserver(schedule);
    observer.observe(shell, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [refreshDomBinding]);

  useEffect(() => {
    const parts = getWorkspaceParts();
    const center = parts?.center;
    if (!center) return;

    const bubbles = Array.from(center.querySelectorAll<HTMLElement>('div')).filter((element) =>
      typeof element.className === 'string' && element.className.includes('max-w-[80%]')
    );
    const normalized = searchTerm.trim().toLocaleLowerCase('vi-VN');
    let matches = 0;
    let firstMatch: HTMLElement | null = null;

    for (const bubble of bubbles) {
      delete bubble.dataset.nativeSearchMatch;
      if (!normalized) continue;
      const isMatch = (bubble.textContent || '').toLocaleLowerCase('vi-VN').includes(normalized);
      if (isMatch) {
        bubble.dataset.nativeSearchMatch = 'true';
        matches += 1;
        firstMatch ||= bubble;
      }
    }

    const frame = requestAnimationFrame(() => {
      setSearchMatches(matches);
      if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchTerm, channel, getWorkspaceParts]);

  const openZaloHandoff = useCallback(
    async (mode: 'audio' | 'video') => {
      const phone = extractVisiblePhone();
      const customerId = customerIdFromCallHref(callHref);
      let uid: string | null = null;

      setZaloTargetLoading(true);
      try {
        if (customerId) {
          const response = await fetch(
            `/api/inbox/zalo-call-target?customer_id=${encodeURIComponent(customerId)}`,
            { cache: 'no-store' }
          );
          const payload = await response.json().catch(() => null) as
            | { success?: boolean; data?: { uid?: unknown } }
            | null;
          if (response.ok && payload?.success && typeof payload.data?.uid === 'string') {
            uid = payload.data.uid;
          }
        }

        const target = buildZaloHandoffTarget({ phone, uid });
        setHandoffNotice({
          mode,
          targeted: target.targeted,
          fallbackUrl: target.webUrl,
          targetKind: target.targetKind,
        });

        if (!target.targeted) return;

        if (target.deepLink) {
          // Full phone is available to the current actor: ask the installed Zalo PC
          // client to open that exact conversation. The UID-based Web link remains
          // available in the toast as a deterministic fallback.
          window.location.href = target.deepLink;
          return;
        }

        if (target.webUrl) {
          // UID-only contacts (the normal ZCAJS directory case) cannot be targeted
          // through Zalo's public desktop phone URI. Open the exact Zalo Web thread
          // by UID instead of dumping the sale into generic Zalo search.
          window.open(target.webUrl, '_blank', 'noopener,noreferrer');
        }
      } finally {
        setZaloTargetLoading(false);
      }
    },
    [callHref, extractVisiblePhone]
  );

  const handleAudioCall = useCallback(() => {
    if (channel === 'zalo') {
      void openZaloHandoff('audio');
      return;
    }
    if (callHref) window.location.href = callHref;
  }, [callHref, channel, openZaloHandoff]);

  const handleVideoCall = useCallback(() => {
    if (channel === 'zalo') void openZaloHandoff('video');
  }, [channel, openZaloHandoff]);

  return (
    <div
      ref={shellRef}
      className="platform-inbox-shell"
      data-chat-channel={channel}
      data-details-open={detailsOpen ? 'true' : 'false'}
    >
      <InboxView
        userRole={userRole}
        userFullName={userFullName}
        initialCustomerId={initialCustomerId}
      />

      {headerHost &&
        createPortal(
          <>
            <div className="platform-native-divider" />
            <IconButton
              title={channel === 'zalo' ? 'Mở đúng chat Zalo để gọi' : 'Gọi khách'}
              onClick={handleAudioCall}
              disabled={
                zaloTargetLoading ||
                channel === 'none' ||
                (channel === 'facebook' && !callHref)
              }
            >
              <Phone size={17} />
            </IconButton>
            <IconButton
              title={
                channel === 'zalo'
                  ? 'Mở đúng chat Zalo để gọi video'
                  : 'Messenger video call chưa được tích hợp vào CRM'
              }
              onClick={handleVideoCall}
              disabled={zaloTargetLoading || channel !== 'zalo'}
            >
              <Video size={18} />
            </IconButton>
            <div className="platform-native-search-wrap">
              <IconButton
                title="Tìm trong cuộc trò chuyện"
                onClick={() => setSearchOpen((value) => !value)}
                disabled={channel === 'none'}
              >
                <Search size={18} />
              </IconButton>
              {searchOpen && (
                <div className="platform-native-search-popover">
                  <Search size={15} />
                  <input
                    autoFocus
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Tìm tin nhắn..."
                    aria-label="Tìm trong cuộc trò chuyện"
                  />
                  {searchTerm && (
                    <span className="platform-native-search-count">{searchMatches}</span>
                  )}
                </div>
              )}
            </div>
            <IconButton
              title={detailsOpen ? 'Ẩn thông tin hội thoại' : 'Hiện thông tin hội thoại'}
              onClick={() => setDetailsOpen((value) => !value)}
              disabled={channel === 'none'}
            >
              {detailsOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </IconButton>
          </>,
          headerHost
        )}

      {contextHost &&
        createPortal(
          <div className="platform-context-card">
            <div className="platform-context-title-row">
              <div>
                <div className="platform-context-kicker">
                  {channel === 'zalo' ? 'Zalo' : channel === 'facebook' ? 'Messenger' : 'Hội thoại'}
                </div>
                <div className="platform-context-title">Thông tin & nội dung chia sẻ</div>
              </div>
              <Info size={16} />
            </div>

            <div className="platform-context-grid">
              <div className="platform-context-stat">
                <ImageIcon size={16} />
                <span>Ảnh/Video</span>
                <strong>{mediaCount}</strong>
              </div>
              <div className="platform-context-stat">
                <FileText size={16} />
                <span>Tệp</span>
                <strong>{fileCount}</strong>
              </div>
              <div className="platform-context-stat">
                <Link2 size={16} />
                <span>Liên kết</span>
                <strong>{linkCount}</strong>
              </div>
            </div>

            {channel === 'zalo' && (
              <button
                type="button"
                className="platform-open-provider-button"
                onClick={() => void openZaloHandoff('audio')}
                disabled={zaloTargetLoading}
              >
                <ExternalLink size={15} />
                <span>Mở đúng cuộc trò chuyện trên Zalo</span>
              </button>
            )}

            <p className="platform-context-note">
              {channel === 'zalo'
                ? 'CRM dùng đúng định danh Zalo của khách để mở hội thoại; không tìm theo tên. Nếu có số đầy đủ sẽ ưu tiên Zalo PC, nếu chỉ có UID sẽ mở thẳng đúng hội thoại Zalo Web.'
                : 'Các thao tác CRM, AI và trạng thái giao nhận vẫn dùng dữ liệu thật của hệ thống; các nút chưa được Meta hỗ trợ sẽ không được giả lập.'}
            </p>
          </div>,
          contextHost
        )}

      {handoffNotice && (
        <div className="platform-handoff-toast" role="status">
          <div className="platform-handoff-icon">
            {handoffNotice.mode === 'video' ? <Video size={18} /> : <Phone size={18} />}
          </div>
          <div className="platform-handoff-copy">
            <strong>
              {handoffNotice.targetKind === 'phone'
                ? 'Đang mở đúng chat trên Zalo PC'
                : handoffNotice.targetKind === 'uid'
                  ? 'Đã mở đúng chat Zalo của khách'
                  : 'Chưa có định danh Zalo cá nhân'}
            </strong>
            <span>
              {handoffNotice.targetKind === 'phone'
                ? 'CRM đã định tuyến đúng khách. Sau khi Zalo PC hiện lên, bấm biểu tượng gọi ở góc trên.'
                : handoffNotice.targetKind === 'uid'
                  ? 'Khách này chưa có số điện thoại trong CRM, nên hệ thống mở đúng hội thoại Zalo Web bằng UID. Bạn có thể gọi ngay trong hội thoại đó.'
                  : 'CRM không tìm thấy UID Zalo cá nhân chính xác của khách này nên không mở Zalo chung và không đoán theo tên.'}
            </span>
          </div>
          {handoffNotice.fallbackUrl && (
            <a href={handoffNotice.fallbackUrl} target="_blank" rel="noreferrer">
              Mở đúng chat Zalo
            </a>
          )}
          <button type="button" onClick={() => setHandoffNotice(null)} aria-label="Đóng thông báo">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
