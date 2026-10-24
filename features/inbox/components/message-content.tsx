'use client';

import React, { useEffect, useRef, useState } from 'react';

export const ZALO_IMAGE_MARKER = '[[ZALO_IMAGE]]';

/** Checks if a string is a safe HTTP/HTTPS URL. */
export function isSafeHttpUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Strips common conversational trailing punctuation from a URL match while
 * preserving balanced parentheses.
 */
export function sanitizeMatchedUrl(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';

  while (/[.,!?;:)\]"'>]$/.test(url)) {
    if (url.endsWith(')')) {
      const openCount = (url.match(/\(/g) || []).length;
      const closeCount = (url.match(/\)/g) || []).length;
      if (closeCount <= openCount) break;
    }
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}

/** Safe hostname extractor without throwing. */
export function getSafeHostname(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

/** Checks if trimmed message consists of exactly one safe http/https URL. */
export function isSingleUrlMessage(content: string): { isSingle: boolean; url?: string } {
  if (!content) return { isSingle: false };
  const trimmed = content.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    const { url, trailing } = sanitizeMatchedUrl(trimmed);
    if (!trailing && isSafeHttpUrl(url)) return { isSingle: true, url };
  }
  return { isSingle: false };
}

export function extractZaloImageMarkers(content: string): { text: string; imageUrls: string[] } {
  const textLines: string[] = [];
  const imageUrls: string[] = [];

  for (const line of String(content || '').split(/\r?\n/)) {
    if (line.startsWith(ZALO_IMAGE_MARKER)) {
      const candidate = line.slice(ZALO_IMAGE_MARKER.length).trim();
      if (isSafeHttpUrl(candidate)) {
        imageUrls.push(candidate);
        continue;
      }
    }
    textLines.push(line);
  }

  return {
    text: textLines.join('\n').trim(),
    imageUrls: [...new Set(imageUrls)],
  };
}

interface MessageContentProps {
  content: string;
  isOutbound?: boolean;
}

function LinkWithHoverCard({
  url,
  children,
  isOutbound,
}: {
  url: string;
  children: React.ReactNode;
  isOutbound?: boolean;
}) {
  const [showHover, setShowHover] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hostname = getSafeHostname(url);

  const show = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    setShowHover(true);
  };
  const hide = () => {
    hideTimeoutRef.current = setTimeout(() => setShowHover(false), 120);
  };

  useEffect(() => () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
  }, []);

  return (
    <span className="relative inline-block" onMouseEnter={show} onMouseLeave={hide}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onFocus={show}
        onBlur={hide}
        className={`underline underline-offset-2 break-all transition-colors rounded-sm ${
          isOutbound ? 'text-blue-100 hover:text-white font-medium' : 'text-blue-400 hover:text-blue-300 font-medium'
        }`}
      >
        {children}
        <span className="ml-0.5 text-[10px]" aria-hidden="true">↗</span>
      </a>
      {showHover && (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-30 w-64 max-w-[calc(100vw-3rem)] p-2.5 rounded-xl bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] shadow-dropdown text-xs"
        >
          <span className="block font-semibold truncate">{hostname}</span>
          <span className="block text-[11px] text-[var(--text-tertiary)] truncate font-mono mt-1">{url}</span>
        </span>
      )}
    </span>
  );
}

function SingleUrlLinkCard({ url, isOutbound }: { url: string; isOutbound?: boolean }) {
  const hostname = getSafeHostname(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group block p-3 rounded-xl border transition-all ${
        isOutbound
          ? 'bg-blue-700/80 hover:bg-blue-700 border-blue-400/40 text-white'
          : 'bg-[var(--surface-secondary)] border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--border-strong)]'
      }`}
    >
      <div className="font-semibold text-xs truncate group-hover:underline">{hostname} ↗</div>
      <div className={`text-[11px] truncate font-mono mt-1 ${isOutbound ? 'text-blue-100/90' : 'text-[var(--text-secondary)]'}`}>
        {url}
      </div>
    </a>
  );
}

function ZaloImage({ url, isOutbound }: { url: string; isOutbound?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1 text-xs underline ${isOutbound ? 'text-blue-100' : 'text-blue-400'}`}
      >
        Mở ảnh trên Zalo CDN ↗
      </a>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block max-w-sm">
      {/* Provider-hosted media: plain img avoids Next.js remote-host coupling. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Ảnh gửi qua Zalo"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="block max-h-80 max-w-full rounded-xl object-contain bg-black/20 border border-white/10"
      />
    </a>
  );
}

function TextWithLinks({ content, isOutbound }: MessageContentProps) {
  if (!content) return null;
  const singleUrlCheck = isSingleUrlMessage(content);
  if (singleUrlCheck.isSingle && singleUrlCheck.url) {
    return <SingleUrlLinkCard url={singleUrlCheck.url} isOutbound={isOutbound} />;
  }

  const parts = content.split(/(https?:\/\/[^\s]+)/gi);
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        if (!part) return null;
        if (/^https?:\/\//i.test(part)) {
          const { url, trailing } = sanitizeMatchedUrl(part);
          if (isSafeHttpUrl(url)) {
            return (
              <React.Fragment key={`${url}-${index}`}>
                <LinkWithHoverCard url={url} isOutbound={isOutbound}>{url}</LinkWithHoverCard>
                {trailing}
              </React.Fragment>
            );
          }
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </span>
  );
}

/**
 * Safely renders text/links and ZCAJS image markers without dangerouslySetInnerHTML.
 */
export function MessageContent({ content, isOutbound }: MessageContentProps) {
  if (!content) return null;
  const { text, imageUrls } = extractZaloImageMarkers(content);

  if (imageUrls.length === 0) {
    return <TextWithLinks content={content} isOutbound={isOutbound} />;
  }

  return (
    <div className="space-y-2">
      {text ? <TextWithLinks content={text} isOutbound={isOutbound} /> : null}
      {imageUrls.map((url) => <ZaloImage key={url} url={url} isOutbound={isOutbound} />)}
    </div>
  );
}

export default MessageContent;
