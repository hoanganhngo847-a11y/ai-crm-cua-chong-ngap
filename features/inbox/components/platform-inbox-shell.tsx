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
  fallbackUrl: string;
} | null;

function normalizeVisiblePhone(value: string | null | undefined): string | null {
  if (!value || value.includes('*')) return null;
  let digits = value.replace(/[^0-9+]/g, '');
  if (!digits) return null;

  if (/^\+84[1-9][0-9]{7,12}$/.test(digits)) {
    digits = `0${digits.slice(3)}`;
  } else if (/^84[1-9][0-9]{7,12}$/.test(digits)) {
    digits = `0${digits.slice(2)}`;
  }

  return /^0[1-9][0-9]{7,12}$/.test(digits) ? digits : null;
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
    return normalizeVisiblePhone(value);
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
          ? 'Mở cuộc trò chuyện trên Zalo PC để gọi khách'
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
    (mode: 'audio' | 'video') => {
      const phone = extractVisiblePhone();
      const targeted = Boolean(phone);
      const fallbackUrl = phone
        ? `https://chat.zalo.me/?phone=${encodeURIComponent(phone!)}&openConv=true`
        : 'https://chat.zalo.me/';
      const deepLink = phone
        ? `zalo://conversation?phone=${encodeURIComponent(phone!)}`
        : 'zalo://';

      setHandoffNotice({ mode, targeted, fallbackUrl });

      // Best effort only. Zalo does not publish a stable desktop URI for directly
      // starting a personal voice/video call. When a full phone is already visible
      // to the current actor we ask Zalo PC to open that conversation; otherwise we
      // open Zalo without leaking masked/private phone data.
      window.location.href = deepLink;
    },
    [extractVisiblePhone]
  );

  const handleAudioCall = useCallback(() => {
    if (channel === 'zalo') {
      openZaloHandoff('audio');
      return;
    }
    if (callHref) window.location.href = callHref;
  }, [callHref, channel, openZaloHandoff]);

  const handleVideoCall = useCallback(() => {
    if (channel === 'zalo') openZaloHandoff('video');
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
              title={channel === 'zalo' ? 'Gọi qua Zalo PC' : 'Gọi khách'}
              onClick={handleAudioCall}
              disabled={channel === 'none' || (channel === 'facebook' && !callHref)}
            >
              <Phone size={17} />
            </IconButton>
            <IconButton
              title={
                channel === 'zalo'
                  ? 'Mở Zalo PC để gọi video'
                  : 'Messenger video call chưa được tích hợp vào CRM'
              }
              onClick={handleVideoCall}
              disabled={channel !== 'zalo'}
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
                onClick={() => openZaloHandoff('audio')}
              >
                <ExternalLink size={15} />
                <span>Mở cuộc trò chuyện trên Zalo PC</span>
              </button>
            )}

            <p className="platform-context-note">
              {channel === 'zalo'
                ? 'Ghim, phân loại, tắt thông báo và các thao tác chỉ có trên Zalo được thực hiện trong Zalo PC để tránh giả lập trạng thái không đồng bộ.'
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
            <strong>Đang mở Zalo PC</strong>
            <span>
              {handoffNotice.targeted
                ? 'CRM đã yêu cầu Zalo mở cuộc trò chuyện của khách. Sau khi Zalo hiện lên, bấm biểu tượng gọi ở góc trên.'
                : 'CRM không được phép lộ số điện thoại đầy đủ cho tài khoản này, nên chỉ mở Zalo. Tìm khách rồi bấm biểu tượng gọi.'}
            </span>
          </div>
          <a href={handoffNotice.fallbackUrl} target="_blank" rel="noreferrer">
            Mở Zalo Web
          </a>
          <button type="button" onClick={() => setHandoffNotice(null)} aria-label="Đóng thông báo">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
