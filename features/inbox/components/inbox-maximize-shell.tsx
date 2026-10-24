'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Info,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useAppShell } from '../../../components/app-shell/app-shell';
import PlatformInboxShell from './platform-inbox-shell';
import './inbox-maximize-shell.css';

interface InboxMaximizeShellProps {
  userRole?: string | null;
  userFullName?: string | null;
  initialCustomerId?: string | null;
}

function CompactButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="inbox-maximize-action"
    >
      {children}
    </button>
  );
}

export default function InboxMaximizeShell({
  userRole,
  userFullName,
  initialCustomerId,
}: InboxMaximizeShellProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [headerHost, setHeaderHost] = useState<HTMLElement | null>(null);
  const [conversationListOpen, setConversationListOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { isFocusMode, setFocusMode } = useAppShell();

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame = 0;
    const bindHeaderHost = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const host = root.querySelector<HTMLElement>('[data-platform-header-host="true"]');
        setHeaderHost((current) => (current === host ? current : host));
      });
    };

    bindHeaderHost();
    const observer = new MutationObserver(bindHeaderHost);
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isFocusMode) return;
      event.preventDefault();
      setFocusMode(false);
      setConversationListOpen(true);
      setDetailsOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFocusMode, setFocusMode]);

  const toggleFocusMode = () => {
    if (isFocusMode) {
      setFocusMode(false);
      setConversationListOpen(true);
      setDetailsOpen(false);
      return;
    }

    setConversationListOpen(false);
    setDetailsOpen(false);
    setFocusMode(true);
  };

  return (
    <div
      ref={rootRef}
      className="inbox-maximize-shell"
      data-list-open={conversationListOpen ? 'true' : 'false'}
      data-details-open={detailsOpen ? 'true' : 'false'}
      data-focus-mode={isFocusMode ? 'true' : 'false'}
    >
      <PlatformInboxShell
        userRole={userRole}
        userFullName={userFullName}
        initialCustomerId={initialCustomerId}
      />

      {headerHost &&
        createPortal(
          <>
            <span className="inbox-maximize-divider" aria-hidden="true" />
            <CompactButton
              title={conversationListOpen ? 'Ẩn danh sách hội thoại' : 'Hiện danh sách hội thoại'}
              onClick={() => setConversationListOpen((value) => !value)}
            >
              {conversationListOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </CompactButton>
            <CompactButton
              title={detailsOpen ? 'Đóng hồ sơ khách hàng' : 'Mở hồ sơ khách hàng'}
              onClick={() => setDetailsOpen((value) => !value)}
            >
              <Info size={17} />
            </CompactButton>
            <CompactButton
              title={isFocusMode ? 'Thoát chế độ tập trung (Esc)' : 'Phóng to khung chat'}
              onClick={toggleFocusMode}
            >
              {isFocusMode ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </CompactButton>
          </>,
          headerHost
        )}

      {detailsOpen && (
        <button
          type="button"
          className="inbox-maximize-backdrop"
          aria-label="Đóng hồ sơ khách hàng"
          onClick={() => setDetailsOpen(false)}
        />
      )}
    </div>
  );
}
