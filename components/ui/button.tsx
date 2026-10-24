'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'subtle' | 'outline' | 'ghost' | 'danger';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className = '',
      variant = 'secondary',
      size = 'sm',
      isLoading = false,
      disabled = false,
      leftIcon,
      rightIcon,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium transition-colors select-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] disabled:opacity-50 disabled:pointer-events-none cursor-pointer';

    const sizeStyles = {
      xs: 'h-7 px-2 text-xs rounded-md gap-1.5',
      sm: 'h-8 px-2.5 text-xs rounded-md gap-1.5',
      md: 'h-9 px-3.5 text-sm rounded-lg gap-2',
      lg: 'h-10 px-4 text-sm rounded-lg gap-2',
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
        'bg-[var(--danger)] text-white hover:bg-red-700 shadow-xs border border-transparent',
    };

    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-current" />
        ) : (
          leftIcon && <span className="shrink-0">{leftIcon}</span>
        )}
        <span>{children}</span>
        {!isLoading && rightIcon && <span className="shrink-0">{rightIcon}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';
