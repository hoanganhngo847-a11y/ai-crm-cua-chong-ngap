'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'subtle' | 'outline' | 'ghost' | 'danger';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  'aria-label': string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      children,
      className = '',
      variant = 'ghost',
      size = 'sm',
      isLoading = false,
      disabled = false,
      type = 'button',
      'aria-label': ariaLabel,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium transition-colors select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] disabled:opacity-50 disabled:pointer-events-none cursor-pointer';

    const sizeStyles = {
      xs: 'w-7 h-7 text-xs rounded-md',
      sm: 'w-8 h-8 text-xs rounded-md',
      md: 'w-9 h-9 text-sm rounded-lg',
      lg: 'w-10 h-10 text-base rounded-lg',
    };

    const variantStyles = {
      primary:
        'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] shadow-xs border border-transparent',
      secondary:
        'bg-[var(--surface-primary)] text-[var(--text-primary)] border border-[var(--border-subtle)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)] shadow-xs',
      subtle:
        'bg-[var(--surface-secondary)] text-[var(--text-primary)] border border-transparent hover:bg-[var(--surface-hover)]',
      outline:
        'bg-transparent text-[var(--text-primary)] border border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]',
      ghost:
        'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
      danger:
        'bg-[var(--danger-surface)] text-[var(--danger)] hover:bg-red-100 border border-[var(--danger-border)]',
    };

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        aria-label={ariaLabel}
        className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-current" />
        ) : (
          children
        )}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
