'use client';

import React from 'react';
import { Search, X } from 'lucide-react';

export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  onClear?: () => void;
  shortcut?: string;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onChange, onClear, placeholder = 'Tìm kiếm...', shortcut, className = '', ...props }, ref) => {
    const hasValue = value !== undefined && value !== null && value !== '';

    return (
      <div className={`relative flex items-center w-full max-w-xs ${className}`}>
        <Search className="w-3.5 h-3.5 absolute left-2.5 text-[var(--text-tertiary)] pointer-events-none" />
        <input
          ref={ref}
          type="search"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="w-full h-8 pl-8 pr-7 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
          {...props}
        />
        {hasValue && onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="absolute right-2 p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Xóa tìm kiếm"
          >
            <X className="w-3 h-3" />
          </button>
        ) : shortcut ? (
          <div className="absolute right-2 pointer-events-none hidden sm:flex items-center text-[10px] font-mono text-[var(--text-tertiary)] border border-[var(--border-subtle)] px-1 py-0.2 rounded bg-[var(--surface-secondary)]">
            {shortcut}
          </div>
        ) : null}
      </div>
    );
  }
);
SearchInput.displayName = 'SearchInput';
