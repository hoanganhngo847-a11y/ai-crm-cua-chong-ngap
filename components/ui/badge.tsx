'use client';

import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'ai';
  size?: 'xs' | 'sm' | 'md';
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  className = '',
  variant = 'neutral',
  size = 'sm',
  ...props
}) => {
  const sizeStyles = {
    xs: 'px-1.5 py-0.5 text-[10px] leading-tight font-medium',
    sm: 'px-2 py-0.5 text-xs font-medium',
    md: 'px-2.5 py-1 text-xs font-semibold',
  };

  const variantStyles = {
    neutral:
      'bg-[var(--surface-secondary)] text-[var(--text-secondary)] border border-[var(--border-subtle)]',
    info: 'bg-[var(--info-surface)] text-[var(--info)] border border-[var(--info-border)]',
    success:
      'bg-[var(--success-surface)] text-[var(--success)] border border-[var(--success-border)]',
    warning:
      'bg-[var(--warning-surface)] text-[var(--warning)] border border-[var(--warning-border)]',
    danger:
      'bg-[var(--danger-surface)] text-[var(--danger)] border border-[var(--danger-border)]',
    accent:
      'bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent-border)]',
    ai: 'bg-[var(--ai-surface)] text-[var(--ai)] border border-[var(--ai-border)]',
  };

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full transition-colors whitespace-nowrap ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {children}
    </span>
  );
};
