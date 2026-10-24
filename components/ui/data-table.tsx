import React from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from './button';

export const Table = React.forwardRef<
  HTMLTableElement,
  React.TableHTMLAttributes<HTMLTableElement>
>(({ className = '', ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={`w-full caption-bottom text-xs text-left border-collapse ${className}`}
      {...props}
    />
  </div>
));
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className = '', ...props }, ref) => (
  <thead
    ref={ref}
    className={`bg-[var(--surface-secondary)] text-[var(--text-secondary)] font-medium sticky top-0 z-10 border-b border-[var(--border-subtle)] ${className}`}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className = '', ...props }, ref) => (
  <tbody
    ref={ref}
    className={`divide-y divide-[var(--border-subtle)] bg-[var(--surface-primary)] ${className}`}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }
>(({ className = '', selected, ...props }, ref) => (
  <tr
    ref={ref}
    className={`transition-colors hover:bg-[var(--surface-hover)] ${
      selected ? 'bg-[var(--accent-soft)]' : ''
    } ${className}`}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { alignRight?: boolean }
>(({ className = '', alignRight, ...props }, ref) => (
  <th
    ref={ref}
    className={`h-9 px-3 text-xs font-semibold select-none ${
      alignRight ? 'text-right' : 'text-left'
    } ${className}`}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { alignRight?: boolean }
>(({ className = '', alignRight, ...props }, ref) => (
  <td
    ref={ref}
    className={`px-3 py-2.5 align-middle text-[var(--text-primary)] ${
      alignRight ? 'text-right font-mono' : 'text-left'
    } ${className}`}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

export interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  getPageHref?: (page: number) => string;
  className?: string;
}

export const TablePagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  getPageHref,
  className = '',
}) => {
  const renderPageButton = (
    page: number,
    disabled: boolean,
    icon: React.ReactNode,
    label: string
  ) => {
    // When href generation is supplied by a Server Component, keep the whole
    // pagination branch server-renderable. Never pass callbacks across the
    // Server -> Client boundary just to render a disabled navigation control.
    if (getPageHref) {
      if (disabled) {
        return (
          <span
            className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] text-xs text-[var(--text-tertiary)] opacity-50 cursor-not-allowed"
            aria-label={label}
            aria-disabled="true"
          >
            {icon}
          </span>
        );
      }

      return (
        <Link
          href={getPageHref(page)}
          className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-primary)] hover:bg-[var(--surface-hover)] text-xs text-[var(--text-secondary)] transition-colors"
          aria-label={label}
        >
          {icon}
        </Link>
      );
    }

    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() => onPageChange?.(page)}
        disabled={disabled}
        aria-label={label}
      >
        {icon}
      </Button>
    );
  };

  return (
    <div
      className={`flex items-center justify-between px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--surface-primary)] text-xs text-[var(--text-secondary)] select-none ${className}`}
    >
      <div className="flex items-center gap-1.5">
        {totalItems !== undefined && (
          <span>
            Tổng cộng: <strong className="font-semibold text-[var(--text-primary)] font-mono">{totalItems}</strong> mục
          </span>
        )}
        {pageSize !== undefined && totalItems !== undefined && (
          <span className="hidden sm:inline text-[var(--text-tertiary)]">
            (Trang {currentPage} / {Math.max(1, totalPages)})
          </span>
        )}
      </div>

      <div className="flex items-center gap-1">
        {renderPageButton(1, currentPage <= 1, <ChevronsLeft className="w-3.5 h-3.5" />, 'Trang đầu')}
        {renderPageButton(currentPage - 1, currentPage <= 1, <ChevronLeft className="w-3.5 h-3.5" />, 'Trang trước')}
        <span className="px-2 text-xs font-medium font-mono text-[var(--text-primary)]">
          {currentPage} / {Math.max(1, totalPages)}
        </span>
        {renderPageButton(currentPage + 1, currentPage >= totalPages, <ChevronRight className="w-3.5 h-3.5" />, 'Trang sau')}
        {renderPageButton(totalPages, currentPage >= totalPages, <ChevronsRight className="w-3.5 h-3.5" />, 'Trang cuối')}
      </div>
    </div>
  );
};