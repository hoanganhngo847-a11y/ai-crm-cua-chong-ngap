'use client';

import React, { useState, useRef, useEffect } from 'react';

/**
 * Checks if a string is a safe HTTP/HTTPS URL
 */
export function isSafeHttpUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Strips common conversational trailing punctuation from a URL match.
 * Properly preserves balanced parentheses e.g. https://wikipedia.org/wiki/Foo_(bar)
 */
export function sanitizeMatchedUrl(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';

  while (/[.,!?;:)\]"'>]$/.test(url)) {
    // If ending in parenthesis, check if there's a matching opening parenthesis
    if (url.endsWith(')')) {
      const openCount = (url.match(/\(/g) || []).length;
      const closeCount = (url.match(/\)/g) || []).length;
      if (closeCount <= openCount) {
        break;
      }
    }
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }

  return { url, trailing };
}

/**
 * Safe hostname extractor without throwing
 */
export function getSafeHostname(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname;
  } catch {
    return urlStr;
  }
}

/**
 * Checks if trimmed message consists of exactly ONE safe http/https URL
 */
export function isSingleUrlMessage(content: string): { isSingle: boolean; url?: string } {
  if (!content) return { isSingle: false };
  const trimmed = content.trim();
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    const { url, trailing } = sanitizeMatchedUrl(trimmed);
    if (!trailing && isSafeHttpUrl(url)) {
      return { isSingle: true, url };
    }
  }
  return { isSingle: false };
}

interface MessageContentProps {
  content: string;
  isOutbound?: boolean;
}

/**
 * Hover Card for inline links (NameThatUI pattern)
 * Accessible on hover or focus, zero remote metadata fetch (SSRF-free)
 */
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
  const containerRef = useRef<HTMLSpanElement | null>(null);

  const hostname = getSafeHostname(url);

  const handleMouseEnter = () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    setShowHover(true);
  };

  const handleMouseLeave = () => {
    hideTimeoutRef.current = setTimeout(() => {
      setShowHover(false);
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  return (
    <span
      ref={containerRef}
      className="relative inline-block"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setShowHover(false);
          }
        }}
        className={`underline underline-offset-2 break-all transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 rounded-sm ${
          isOutbound
            ? 'text-blue-100 hover:text-white focus-visible:ring-white focus-visible:ring-offset-blue-600 font-medium'
            : 'text-blue-400 hover:text-blue-300 focus-visible:ring-blue-400 focus-visible:ring-offset-slate-900 font-medium'
        }`}
      >
        {children}
        <svg
          className="w-3 h-3 inline-block ml-0.5 -mt-0.5 opacity-75"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
          />
        </svg>
      </a>

      {showHover && (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-30 w-64 max-w-[calc(100vw-3rem)] p-2.5 rounded-xl bg-slate-900 text-slate-100 border border-slate-700/80 shadow-2xl text-xs space-y-1.5 animate-in fade-in zoom-in-95 duration-150 pointer-events-auto"
        >
          <span className="flex items-center gap-1.5 font-semibold text-slate-200 truncate">
            <svg
              className="w-3.5 h-3.5 text-blue-400 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              />
            </svg>
            <span className="truncate">{hostname}</span>
          </span>
          <span className="block text-[11px] text-slate-400 truncate font-mono">
            {url}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 pt-0.5"
          >
            <span>Mở liên kết</span>
            <span aria-hidden="true">↗</span>
          </a>
        </span>
      )}
    </span>
  );
}

/**
 * Compact Share/Link Card for URL-Only messages (NameThatUI pattern)
 * Zero server-side fetch / zero SSRF.
 */
function SingleUrlLinkCard({ url, isOutbound }: { url: string; isOutbound?: boolean }) {
  const hostname = getSafeHostname(url);

  return (
    <div className="space-y-2">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`group block p-3 rounded-xl border transition-all duration-150 focus:outline-none focus-visible:ring-2 ${
          isOutbound
            ? 'bg-blue-700/60 hover:bg-blue-700/90 border-blue-400/40 text-white focus-visible:ring-white'
            : 'bg-slate-900/90 hover:bg-slate-850 border-slate-700/80 text-slate-100 hover:border-slate-600 focus-visible:ring-blue-400'
        }`}
      >
        <div className="flex items-start gap-2.5">
          <div
            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              isOutbound ? 'bg-blue-500/30 text-white' : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
            }`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-xs truncate group-hover:underline flex items-center gap-1">
              <span className="truncate">{hostname}</span>
              <span className="text-[10px] opacity-75 shrink-0" aria-hidden="true">↗</span>
            </div>
            <div className={`text-[11px] truncate font-mono mt-0.5 ${isOutbound ? 'text-blue-100/80' : 'text-slate-400'}`}>
              {url}
            </div>
          </div>
        </div>
        <div className="mt-2 pt-2 border-t border-white/10 flex items-center justify-between text-[11px]">
          <span className={isOutbound ? 'text-blue-100' : 'text-slate-300'}>Mở liên kết trong tab mới</span>
          <span className="font-medium flex items-center gap-0.5">
            Mở ngay <span aria-hidden="true">↗</span>
          </span>
        </div>
      </a>
    </div>
  );
}

/**
 * MessageContent: Safely renders message content with clickable URLs,
 * security sanitization, and NameThatUI link patterns.
 * Never uses dangerouslySetInnerHTML.
 */
export function MessageContent({ content, isOutbound }: MessageContentProps) {
  if (!content) return null;

  // Pattern B: If the trimmed message is a single safe URL, render compact Link Card
  const singleUrlCheck = isSingleUrlMessage(content);
  if (singleUrlCheck.isSingle && singleUrlCheck.url) {
    return <SingleUrlLinkCard url={singleUrlCheck.url} isOutbound={isOutbound} />;
  }

  // Pattern A: Mixed text + URLs
  // Split on potential http/https URLs
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const parts = content.split(urlRegex);

  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        if (!part) return null;

        if (/^https?:\/\//i.test(part)) {
          const { url, trailing } = sanitizeMatchedUrl(part);
          if (isSafeHttpUrl(url)) {
            return (
              <React.Fragment key={index}>
                <LinkWithHoverCard url={url} isOutbound={isOutbound}>
                  {url}
                </LinkWithHoverCard>
                {trailing}
              </React.Fragment>
            );
          }
        }

        // Plain text segment: React automatically escapes HTML
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </span>
  );
}

export default MessageContent;
