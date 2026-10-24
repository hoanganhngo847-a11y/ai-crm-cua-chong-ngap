'use client';

import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      leftIcon,
      rightIcon,
      id,
      className = '',
      disabled,
      ...props
    },
    ref
  ) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);
    const errorId = inputId && error ? `${inputId}-error` : undefined;
    const helperId = inputId && helperText ? `${inputId}-helper` : undefined;

    return (
      <div className="w-full flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-medium text-[var(--text-secondary)] select-none"
          >
            {label}
          </label>
        )}

        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-2.5 flex items-center pointer-events-none text-[var(--text-tertiary)]">
              {leftIcon}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            aria-invalid={!!error}
            aria-describedby={errorId || helperId}
            className={`w-full h-8 px-2.5 text-xs bg-[var(--surface-primary)] text-[var(--text-primary)] border rounded-md transition-colors placeholder:text-[var(--text-disabled)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] focus:border-[var(--accent)] disabled:bg-[var(--surface-secondary)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed ${
              leftIcon ? 'pl-8' : ''
            } ${rightIcon ? 'pr-8' : ''} ${
              error
                ? 'border-[var(--danger)] focus:ring-[var(--danger)] focus:border-[var(--danger)]'
                : 'border-[var(--border-subtle)] hover:border-[var(--border-strong)]'
            } ${className}`}
            {...props}
          />

          {rightIcon && (
            <div className="absolute right-2.5 flex items-center text-[var(--text-tertiary)]">
              {rightIcon}
            </div>
          )}
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
Input.displayName = 'Input';
