'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { InboxChannel } from '../types/inbox.types';

const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

interface PendingAttachment {
  id: string;
  file: File;
  previewUrl?: string;
}

interface ZaloComposerProps {
  channel: InboxChannel;
  draft: string;
  disabled?: boolean;
  aiLoading?: boolean;
  customerName?: string;
  customerPhone?: string;
  onDraftChange: (value: string) => void;
  onSendText: () => Promise<void> | void;
  onQuickSend: (text: string) => Promise<boolean> | boolean;
  onSendMedia: (files: File[], caption: string) => Promise<boolean>;
  onRequestAi: () => Promise<void> | void;
}

const QUICK_REPLIES = [
  'Chào anh/chị, em đang kiểm tra thông tin và phản hồi ngay ạ.',
  'Anh/chị cho em xin số điện thoại để em hỗ trợ nhanh hơn nhé.',
  'Em đã ghi nhận thông tin. Em sẽ phản hồi anh/chị ngay khi kiểm tra xong ạ.',
  'Cảm ơn anh/chị đã nhắn tin. Anh/chị cần em hỗ trợ thêm nội dung nào nữa không ạ?',
];

const EMOJIS = ['😀', '😄', '😊', '😍', '🥰', '😂', '😉', '👍', '🙏', '❤️', '🎉', '🔥', '✅', '💯', '📌', '📞', '💬', '✨'];
const STICKER_LIKE = ['👍', '❤️', '😂', '😍', '🎉', '👏', '🙏', '💪', '👌', '🔥', '✨', '🥳'];

function ToolbarButton({
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`w-6 h-6 sm:w-7 sm:h-7 rounded-md flex items-center justify-center transition border ${
        active
          ? 'bg-blue-50 border-blue-200 text-blue-600'
          : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
      } disabled:opacity-35 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

function bytesLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAttachment(file: File): PendingAttachment {
  return {
    id: crypto.randomUUID(),
    file,
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  };
}

export default function ZaloComposer({
  channel,
  draft,
  disabled = false,
  aiLoading = false,
  customerName,
  customerPhone,
  onDraftChange,
  onSendText,
  onQuickSend,
  onSendMedia,
  onRequestAi,
}: ZaloComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [panel, setPanel] = useState<'emoji' | 'sticker' | 'quick' | 'format' | 'more' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [mediaSending, setMediaSending] = useState(false);
  const attachmentRef = useRef<PendingAttachment[]>([]);

  useEffect(() => {
    attachmentRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    return () => {
      for (const item of attachmentRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    };
  }, []);

  const totalBytes = useMemo(
    () => attachments.reduce((sum, item) => sum + item.file.size, 0),
    [attachments]
  );
  const busy = disabled || mediaSending;
  const canUseZaloMedia = channel === 'zalo';
  const hasContent = Boolean(draft.trim()) || attachments.length > 0;

  // Auto-expand textarea on typing multiple lines and shrink to 1 compact row when empty
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    const targetHeight = Math.min(Math.max(scrollHeight, 28), 120);
    el.style.height = `${targetHeight}px`;
  }, [draft]);

  const closePanels = () => setPanel(null);

  const clearAttachments = () => {
    setAttachments((current) => {
      for (const item of current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
  };

  const addFiles = (incoming: File[]) => {
    setLocalError(null);
    if (!incoming.length) return;

    if (!canUseZaloMedia) {
      setLocalError('Gửi ảnh/tệp trực tiếp hiện chỉ được bật cho hội thoại Zalo.');
      return;
    }

    setAttachments((current) => {
      const available = MAX_ATTACHMENTS - current.length;
      if (available <= 0) {
        setLocalError(`Mỗi lần gửi tối đa ${MAX_ATTACHMENTS} tệp.`);
        return current;
      }

      const next: PendingAttachment[] = [];
      let nextTotal = current.reduce((sum, item) => sum + item.file.size, 0);

      for (const file of incoming.slice(0, available)) {
        if (file.size <= 0) continue;
        if (file.size > MAX_FILE_BYTES) {
          setLocalError(`Tệp ${file.name || 'không tên'} vượt quá ${bytesLabel(MAX_FILE_BYTES)}.`);
          continue;
        }
        if (nextTotal + file.size > MAX_TOTAL_BYTES) {
          setLocalError(`Tổng dung lượng đính kèm tối đa ${bytesLabel(MAX_TOTAL_BYTES)}.`);
          break;
        }
        next.push(buildAttachment(file));
        nextTotal += file.size;
      }

      return [...current, ...next];
    });
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (imageFiles.length > 0) {
      event.preventDefault();
      addFiles(imageFiles);
      setPanel(null);
    }
  };

  const readImageFromClipboard = async () => {
    setLocalError(null);
    try {
      if (!navigator.clipboard?.read) {
        setLocalError('Trình duyệt chưa cho phép đọc ảnh trực tiếp từ clipboard. Hãy dùng Cmd/Ctrl + V trong ô chat.');
        return;
      }
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of clipboardItems) {
        for (const type of item.types.filter((value) => value.startsWith('image/'))) {
          const blob = await item.getType(type);
          const extension = type.split('/')[1] || 'png';
          files.push(new File([blob], `clipboard-${Date.now()}.${extension}`, { type }));
        }
      }
      if (!files.length) {
        setLocalError('Clipboard hiện không có ảnh.');
        return;
      }
      addFiles(files);
      closePanels();
      textareaRef.current?.focus();
    } catch {
      setLocalError('Không đọc được clipboard. Hãy bấm vào ô chat rồi dùng Cmd/Ctrl + V.');
    }
  };

  const insertText = (value: string) => {
    const el = textareaRef.current;
    if (!el) {
      onDraftChange(`${draft}${value}`);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = `${draft.slice(0, start)}${value}${draft.slice(end)}`;
    onDraftChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + value.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const transformSelection = (mode: 'bullet' | 'quote' | 'upper') => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? draft.length;
    const selected = draft.slice(start, end) || draft;
    let transformed = selected;
    if (mode === 'bullet') {
      transformed = selected.split(/\r?\n/).map((line) => `• ${line}`).join('\n');
    } else if (mode === 'quote') {
      transformed = selected.split(/\r?\n/).map((line) => `› ${line}`).join('\n');
    } else {
      transformed = selected.toUpperCase();
    }
    const next = start === end && !draft
      ? transformed
      : `${draft.slice(0, start)}${transformed}${draft.slice(end)}`;
    onDraftChange(next);
    closePanels();
    requestAnimationFrame(() => el.focus());
  };

  const insertContact = () => {
    const parts = [customerName ? `👤 ${customerName}` : '👤 Thông tin liên hệ'];
    if (customerPhone) parts.push(`📞 ${customerPhone}`);
    insertText(parts.join('\n'));
  };

  const submit = async () => {
    if (busy || !hasContent) return;
    setLocalError(null);

    if (attachments.length > 0) {
      if (!canUseZaloMedia) {
        setLocalError('Gửi ảnh/tệp trực tiếp hiện chỉ hỗ trợ hội thoại Zalo.');
        return;
      }
      setMediaSending(true);
      try {
        const ok = await onSendMedia(attachments.map((item) => item.file), draft.trim());
        if (ok) clearAttachments();
      } finally {
        setMediaSending(false);
      }
      return;
    }

    await onSendText();
  };

  const sendThumb = async () => {
    if (busy) return;
    setLocalError(null);
    const ok = await onQuickSend('👍');
    if (!ok) setLocalError('Không gửi được biểu tượng 👍.');
  };

  return (
    <div className="relative rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] overflow-visible shadow-subtle">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          addFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          addFiles(Array.from(event.target.files || []));
          event.target.value = '';
        }}
      />

      {/* Toolbar styled after the familiar Zalo desktop composer. */}
      <div className="flex items-center gap-0.5 px-2 py-0.5 border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)]/50 overflow-x-auto rounded-t-lg">
        <ToolbarButton title="Nhãn dán / biểu cảm" active={panel === 'sticker'} onClick={() => setPanel(panel === 'sticker' ? null : 'sticker')} disabled={busy}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4" strokeWidth="1.8"/><path d="M8 10h.01M16 10h.01M8.5 14.5c1 .9 2.2 1.4 3.5 1.4s2.5-.5 3.5-1.4" strokeWidth="1.8" strokeLinecap="round"/></svg>
        </ToolbarButton>
        <ToolbarButton title="Gửi ảnh" onClick={() => imageInputRef.current?.click()} disabled={busy || !canUseZaloMedia}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="2" strokeWidth="1.8"/><circle cx="9" cy="9" r="1.6" strokeWidth="1.8"/><path d="m5 18 4.7-4.8 3.1 3.1 2.1-2.1L19 18" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </ToolbarButton>
        <ToolbarButton title="Đính kèm tệp" onClick={() => fileInputRef.current?.click()} disabled={busy || !canUseZaloMedia}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m8.5 12.7 6.2-6.2a3.3 3.3 0 0 1 4.7 4.7l-8 8a5 5 0 0 1-7.1-7.1l8.2-8.2" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </ToolbarButton>
        <ToolbarButton title="Chèn thông tin liên hệ" onClick={insertContact} disabled={busy}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" strokeWidth="1.8"/><circle cx="9" cy="11" r="2" strokeWidth="1.8"/><path d="M6 16c.8-1.6 1.8-2.4 3-2.4s2.2.8 3 2.4M15 10h3M15 14h3" strokeWidth="1.8" strokeLinecap="round"/></svg>
        </ToolbarButton>
        <div className="relative">
          <ToolbarButton title="Công cụ Zalo" active={panel === 'more'} onClick={() => setPanel(panel === 'more' ? null : 'more')} disabled={busy}>
            <div className="flex items-center gap-0.5"><span className="w-4 h-4 border border-dashed border-current rounded flex items-center justify-center text-[9px] font-bold">Z</span><span className="text-[7px]">▼</span></div>
          </ToolbarButton>
        </div>
        <ToolbarButton title="Định dạng nhanh" active={panel === 'format'} onClick={() => setPanel(panel === 'format' ? null : 'format')} disabled={busy}>
          <span className="flex items-end font-semibold text-sm leading-none">A<span className="text-[9px] ml-0.5">✎</span></span>
        </ToolbarButton>
        <ToolbarButton title="Trả lời nhanh / Gợi ý AI" active={panel === 'quick'} onClick={() => setPanel(panel === 'quick' ? null : 'quick')} disabled={busy}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 5.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8l-4.5 3v-3H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" strokeWidth="1.8"/><path d="m13 7-3 4h2l-1 4 4-5h-2l0-3Z" strokeWidth="1.6" strokeLinejoin="round"/></svg>
        </ToolbarButton>
        <ToolbarButton title="Mẫu tin nhắn" active={panel === 'quick'} onClick={() => setPanel('quick')} disabled={busy}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="2" strokeWidth="1.8"/><path d="M7 9h10M7 12h8M7 15h5" strokeWidth="1.8" strokeLinecap="round"/></svg>
        </ToolbarButton>
        <ToolbarButton title="Thêm" active={panel === 'more'} onClick={() => setPanel(panel === 'more' ? null : 'more')} disabled={busy}>
          <span className="text-sm leading-none tracking-widest -mt-1">•••</span>
        </ToolbarButton>
      </div>

      {panel && (
        <div className="absolute left-2 bottom-[calc(100%+8px)] z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] shadow-dropdown p-2 text-xs">
          {panel === 'emoji' && (
            <div className="grid grid-cols-6 gap-1">
              {EMOJIS.map((emoji) => (
                <button key={emoji} type="button" className="h-9 rounded-lg text-xl hover:bg-[var(--surface-hover)]" onClick={() => { insertText(emoji); closePanels(); }}>{emoji}</button>
              ))}
            </div>
          )}
          {panel === 'sticker' && (
            <div>
              <div className="px-1 pb-2 text-[var(--text-secondary)]">Biểu cảm nhanh</div>
              <div className="grid grid-cols-6 gap-1">
                {STICKER_LIKE.map((emoji) => (
                  <button key={emoji} type="button" className="h-10 rounded-lg text-2xl hover:bg-[var(--surface-hover)]" onClick={() => { insertText(emoji); closePanels(); }}>{emoji}</button>
                ))}
              </div>
            </div>
          )}
          {panel === 'quick' && (
            <div className="space-y-1">
              <button
                type="button"
                disabled={aiLoading}
                onClick={() => { closePanels(); void onRequestAi(); }}
                className="w-full text-left rounded-lg px-3 py-2 bg-purple-50 border border-purple-200 text-purple-700 hover:bg-purple-100 disabled:opacity-50 font-medium"
              >
                ⚡ {aiLoading ? 'Đang tạo gợi ý AI…' : 'Tạo gợi ý trả lời bằng AI'}
              </button>
              {QUICK_REPLIES.map((reply) => (
                <button key={reply} type="button" onClick={() => { onDraftChange(reply); closePanels(); requestAnimationFrame(() => textareaRef.current?.focus()); }} className="w-full text-left rounded-lg px-3 py-2 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] leading-relaxed">
                  {reply}
                </button>
              ))}
            </div>
          )}
          {panel === 'format' && (
            <div className="grid grid-cols-3 gap-1">
              <button type="button" onClick={() => transformSelection('bullet')} className="rounded-lg px-2 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)]">• Danh sách</button>
              <button type="button" onClick={() => transformSelection('quote')} className="rounded-lg px-2 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)]">› Trích dẫn</button>
              <button type="button" onClick={() => transformSelection('upper')} className="rounded-lg px-2 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)]">AA Viết hoa</button>
            </div>
          )}
          {panel === 'more' && (
            <div className="space-y-1">
              <button type="button" onClick={() => void readImageFromClipboard()} className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)]">📋 Dán ảnh từ clipboard</button>
              <button type="button" onClick={() => imageInputRef.current?.click()} disabled={!canUseZaloMedia} className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] disabled:opacity-40">🖼️ Chọn ảnh từ máy</button>
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!canUseZaloMedia} className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--surface-hover)] text-[var(--text-primary)] disabled:opacity-40">📎 Chọn tệp</button>
              {attachments.length > 0 && <button type="button" onClick={() => { clearAttachments(); closePanels(); }} className="w-full text-left rounded-lg px-3 py-2 hover:bg-[var(--surface-hover)] text-rose-600">Xóa toàn bộ tệp đã chọn</button>}
            </div>
          )}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex gap-2 p-2.5 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--surface-secondary)]">
          {attachments.map((item) => (
            <div key={item.id} className="relative shrink-0 w-24 h-24 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] overflow-hidden group">
              {item.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.previewUrl} alt={item.file.name || 'Ảnh đính kèm'} className="w-full h-full object-cover" />
              ) : (
                <div className="h-full p-2 flex flex-col items-center justify-center text-center gap-1 text-[var(--text-secondary)]">
                  <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M7 3h7l4 4v14H7z" strokeWidth="1.7"/><path d="M14 3v5h5" strokeWidth="1.7"/><path d="M9 13h6M9 16h4" strokeWidth="1.7" strokeLinecap="round"/></svg>
                  <span className="text-[10px] line-clamp-2 break-all">{item.file.name}</span>
                </div>
              )}
              <button type="button" onClick={() => removeAttachment(item.id)} title="Bỏ tệp" className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-90 hover:opacity-100">✕</button>
            </div>
          ))}
          <div className="shrink-0 flex items-end text-[10px] text-[var(--text-tertiary)] pb-1">
            {attachments.length}/{MAX_ATTACHMENTS} · {bytesLabel(totalBytes)}
          </div>
        </div>
      )}

      {localError && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center justify-between gap-3">
          <span>{localError}</span>
          <button type="button" className="text-rose-600 font-bold" onClick={() => setLocalError(null)}>✕</button>
        </div>
      )}

      <div className="flex items-end gap-1 px-2 py-1">
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          disabled={busy}
          onChange={(event) => onDraftChange(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={canUseZaloMedia ? 'Nhập tin nhắn tư vấn…' : 'Nhập nội dung tư vấn phản hồi…'}
          className="flex-1 min-h-[28px] max-h-32 bg-transparent border-0 p-1 text-xs sm:text-[13px] text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:outline-none resize-none disabled:opacity-60 leading-tight"
        />

        <ToolbarButton title="Biểu tượng cảm xúc" active={panel === 'emoji'} onClick={() => setPanel(panel === 'emoji' ? null : 'emoji')} disabled={busy}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" strokeWidth="1.8"/><path d="M9 10h.01M15 10h.01M8.5 14c1 1.4 2.1 2 3.5 2s2.5-.6 3.5-2" strokeWidth="1.8" strokeLinecap="round"/></svg>
        </ToolbarButton>

        {hasContent ? (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            title="Gửi"
            className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center transition shadow-subtle shrink-0 disabled:opacity-40"
          >
            {busy ? (
              <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="m4 4 16 8-16 8 3-8-3-8Z" strokeWidth="1.8" strokeLinejoin="round"/><path d="M7 12h13" strokeWidth="1.8"/></svg>
            )}
          </button>
        ) : (
          <button type="button" onClick={() => void sendThumb()} disabled={busy} title="Gửi 👍" className="w-7 h-7 sm:w-8 sm:h-8 rounded-full text-base flex items-center justify-center hover:bg-[var(--surface-hover)] shrink-0 disabled:opacity-40">👍</button>
        )}
      </div>
    </div>
  );
}
