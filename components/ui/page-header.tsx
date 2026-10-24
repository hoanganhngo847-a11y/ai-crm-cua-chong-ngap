'use client';

import React from 'react';
import { Breadcrumb, BreadcrumbItem } from './breadcrumb';

export interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  primaryAction?: React.ReactNode;
  secondaryActions?: React.ReactNode;
  toolbar?: React.ReactNode;
  className?: string;
  badge?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  breadcrumbs,
  primaryAction,
  secondaryActions,
  toolbar,
  className = '',
  badge,
}) => {
  return (
    <div className={`flex flex-col gap-3 pb-4 mb-6 border-b border-[var(--border-subtle)] ${className}`}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb items={breadcrumbs} className="mb-0.5" />
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl sm:text-2xl font-semibold text-[var(--text-primary)] tracking-tight truncate">
              {title}
            </h1>
            {badge && <div className="shrink-0">{badge}</div>}
          </div>
          {description && (
            <div className="text-xs sm:text-sm text-[var(--text-secondary)] mt-0.5 max-w-3xl">
              {description}
            </div>
          )}
        </div>

        {(primaryAction || secondaryActions) && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap sm:flex-nowrap">
            {secondaryActions}
            {primaryAction}
          </div>
        )}
      </div>

      {toolbar && <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">{toolbar}</div>}
    </div>
  );
};
