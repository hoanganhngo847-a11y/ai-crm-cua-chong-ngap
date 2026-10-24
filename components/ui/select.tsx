'use client';

import React from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helperText?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, helperText, id, className = '', children, disabled, ...props }, ref) => {
    const selectId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const errorId = selectId && error ? `${selectId}-error` : undefined;
    const helperId = selectId && helperText ? `${selectId}-helper` : undefined;

    return (
      <div className="w-full flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={selectId}
            className="text-xs font-medium text-[var(--text-secondary)] select-none"
          >
            {label}
          </label>
        )}

        <div className="relative flex items-center">
          <select
            ref={ref}
            id={selectId}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={errorId || helperId}
            className={`w-full h-8 pl-2.5 pr-8 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border rounded-md appearance-none transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent)] focus:border-[var(--accent)] disabled:bg-[var(--surface-secondary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed ${
              error
                ? 'border-[var(--danger)] focus:ring-[var(--danger)] focus:border-[var(--danger)]'
                : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            } ${className}`}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 text-[var(--text-tertiary)] pointer-events-none" />
        </div>

        {error && (
          <span id={errorId} className="text-[11px] text-[var(--danger)]">
            {error}
          </span>
        )}

        {!error && helperText && (
          <span id={helperId} className="text-[11px] text-[var(--text-tertiary)]">
            {helperText}
          </span>
        )}
      </div>
    );
  }
);
Select.displayName = 'Select';
