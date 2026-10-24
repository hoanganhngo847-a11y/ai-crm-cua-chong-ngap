'use client';

import React from 'react';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'rectangular' | 'circular' | 'text';
}

export const Skeleton: React.FC<SkeletonProps> = ({
  variant = 'rectangular',
  className = '',
  ...props
}) => {
  const variantStyles = {
    rectangular: 'rounded-lg',
    circular: 'rounded-full',
    text: 'rounded-sm h-3 w-full',
  };

  return (
    <div
      aria-hidden="true"
      className={`animate-pulse bg-[var(--surface-tertiary)] ${variantStyles[variant]} ${className}`}
      {...props}
    />
  );
};
