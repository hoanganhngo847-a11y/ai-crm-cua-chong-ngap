'use client';

import React, { useState, useRef, useEffect, useTransition } from 'react';
import { Pencil, Check, X, Loader2 } from 'lucide-react';
import { updateCustomerDossierField } from '../../app/actions/customer-dossier';

export interface Customer360EditableCellProps {
  customerId: string;
  field: 'assigned_sale_name' | 'sale_notes' | 'marketing_notes' | 'ai_notes';
  value: string | null | undefined;
  placeholder?: string;
  ownerSuggestions?: string[];
  className?: string;
  isTextarea?: boolean;
}

export function Customer360EditableCell({
  customerId,
  field,
  value,
  placeholder,
  ownerSuggestions,
  className = '',
  isTextarea = field !== 'assigned_sale_name',
}: Customer360EditableCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [currentValue, setCurrentValue] = useState(value ?? '');
  const [draftValue, setDraftValue] = useState(value ?? '');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isPending, startTransition] = useTransition();

  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync state when external value changes
  useEffect(() => {
    setCurrentValue(value ?? '');
    setDraftValue(value ?? '');
  }, [value]);

  useEffect(() => {
    if (isEditing) {
      if (isTextarea && textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.selectionStart = textareaRef.current.value.length;
      } else if (!isTextarea && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }
  }, [isEditing, isTextarea]);

  const handleStartEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraftValue(currentValue);
    setErrorMsg(null);
    setIsEditing(true);
  };

  const handleCancel = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDraftValue(currentValue);
    setErrorMsg(null);
    setIsEditing(false);
  };

  const handleSave = () => {
    const trimmed = draftValue.trim();
    setErrorMsg(null);

    startTransition(async () => {
      try {
        const res = await updateCustomerDossierField({
          customerId,
          field,
          value: trimmed.length > 0 ? trimmed : null,
        });

        if (res.ok) {
          setCurrentValue(res.value ?? '');
          setDraftValue(res.value ?? '');
          setIsEditing(false);
          setIsSuccess(true);
          setTimeout(() => setIsSuccess(false), 2000);
        } else {
          setErrorMsg(res.message || 'Lỗi khi lưu.');
        }
      } catch {
        setErrorMsg('Lỗi mạng. Vui lòng thử lại.');
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    } else if (e.key === 'Enter') {
      if (!isTextarea) {
        e.preventDefault();
        handleSave();
      } else if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        handleSave();
      }
    }
  };

  const defaultPlaceholder =
    placeholder ??
    (field === 'assigned_sale_name'
      ? 'Chưa phân công'
      : field === 'sale_notes'
      ? 'Thêm ghi chú sale...'
      : field === 'marketing_notes'
      ? 'Thêm ghi chú marketing...'
      : 'Thêm ghi chú AI...');

  if (isEditing) {
    const datalistId = `suggestions-${customerId}-${field}`;

    return (
      <div
        className={`relative z-20 flex flex-col gap-1 p-1.5 rounded-md bg-[var(--surface-primary)] border border-[var(--accent)] shadow-sm ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {isTextarea ? (
          <textarea
            ref={textareaRef}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isPending}
            rows={2}
            maxLength={4000}
            placeholder={defaultPlaceholder}
            className="w-full min-w-[160px] max-w-md p-1.5 text-xs text-[var(--text-primary)] bg-transparent resize-y rounded border border-[var(--border-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] leading-relaxed"
          />
        ) : (
          <>
            <input
              ref={inputRef}
              type="text"
              list={ownerSuggestions?.length ? datalistId : undefined}
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isPending}
              maxLength={200}
              placeholder={defaultPlaceholder}
              className="w-full min-w-[130px] max-w-[200px] h-7 px-2 text-xs text-[var(--text-primary)] bg-transparent rounded border border-[var(--border-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
            {ownerSuggestions && ownerSuggestions.length > 0 && (
              <datalist id={datalistId}>
                {ownerSuggestions.map((name, idx) => (
                  <option key={idx} value={name} />
                ))}
              </datalist>
            )}
          </>
        )}

        <div className="flex items-center justify-between gap-1 pt-0.5">
          {errorMsg ? (
            <span className="text-[10px] text-[var(--danger)] truncate max-w-[120px]" title={errorMsg}>
              {errorMsg}
            </span>
          ) : isTextarea ? (
            <span className="text-[10px] text-[var(--text-tertiary)]">Ctrl+Enter để lưu</span>
          ) : (
            <span className="text-[10px] text-[var(--text-tertiary)]">Enter để lưu</span>
          )}

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              title="Lưu (Enter)"
              className="p-1 rounded bg-[var(--accent)] hover:opacity-90 text-white disabled:opacity-50 transition-opacity"
            >
              {isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isPending}
              title="Hủy (Esc)"
              className="p-1 rounded bg-[var(--surface-secondary)] hover:bg-[var(--surface-hover)] text-[var(--text-secondary)] transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Display mode
  const hasValue = Boolean(currentValue && currentValue.trim().length > 0);

  return (
    <div
      onClick={handleStartEdit}
      className={`group relative flex items-start gap-1 p-1 -m-1 rounded cursor-pointer hover:bg-[var(--surface-hover)] transition-colors ${className}`}
      title="Nhấn để chỉnh sửa"
    >
      <div className="min-w-0 flex-1">
        {hasValue ? (
          <p
            className={`text-xs text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors ${
              isTextarea ? 'line-clamp-2 leading-relaxed' : 'truncate font-medium'
            }`}
          >
            {currentValue}
          </p>
        ) : (
          <span className="text-xs text-[var(--text-tertiary)] italic">
            {defaultPlaceholder}
          </span>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-0.5 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isSuccess ? (
          <Check className="w-3 h-3 text-emerald-600 shrink-0" />
        ) : (
          <Pencil className="w-3 h-3 text-[var(--text-tertiary)] group-hover:text-[var(--accent)]" />
        )}
      </div>
    </div>
  );
}
