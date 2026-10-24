'use client';

import React from 'react';

export interface MetricProps {
  label: string;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  trend?: {
    value: string;
    isPositive?: boolean;
  };
  className?: string;
  onClick?: () => void;
}

export const Metric: React.FC<MetricProps> = ({
  label,
  value,
  subtitle,
  icon,
  trend,
  className = '',
  onClick,
}) => {
  return (
    <div
      onClick={onClick}
      className={`p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] shadow-xs flex flex-col justify-between transition-all ${
        onClick ? 'cursor-pointer hover:border-[var(--border-strong)] hover:shadow-sm' : ''
      } ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-medium text-[var(--text-secondary)] truncate">
          {label}
        </span>
        {icon && (
          <span className="p-1 rounded-md bg-[var(--surface-secondary)] text-[var(--text-secondary)] shrink-0">
            {icon}
          </span>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xl sm:text-2xl font-semibold tracking-tight text-[var(--text-primary)] font-mono">
          {value}
        </div>
        {trend && (
          <span
            className={`text-[11px] font-medium font-mono px-1.5 py-0.5 rounded ${
              trend.isPositive
                ? 'bg-[var(--success-surface)] text-[var(--success)]'
                : 'bg-[var(--danger-surface)] text-[var(--danger)]'
            }`}
          >
            {trend.value}
          </span>
        )}
      </div>

      {subtitle && (
        <div className="text-[11px] text-[var(--text-tertiary)] mt-1.5 truncate">
          {subtitle}
        </div>
      )}
    </div>
  );
};
