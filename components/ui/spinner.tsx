'use client';

import React from 'react';
import { Loader2 } from 'lucide-react';

export interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({
  size = 'sm',
  className = '',
  label = 'Đang tải...',
}) => {
  const sizeStyles = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  return (
    <div
      role="status"
      className={`inline-flex items-center justify-center gap-2 ${className}`}
    >
      <Loader2
        className={`animate-spin text-[var(--accent)] ${sizeStyles[size]}`}
      />
      <span className="sr-only">{label}</span>
    </div>
  );
};
