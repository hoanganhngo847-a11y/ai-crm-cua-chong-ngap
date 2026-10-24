'use client';

import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './icon-button';

export interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  className?: string;
  side?: 'right' | 'left';
}

export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className = '',
  side = 'right',
}) => {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocus.current = document.activeElement as HTMLElement;
      drawerRef.current?.focus();

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      };
      window.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';

      return () => {
        window.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = '';
        previousFocus.current?.focus?.();
      };
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sizeStyles = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-xl',
    xl: 'max-w-2xl',
    full: 'max-w-full',
  };

  const sideStyles = {
    right: 'right-0 border-l',
    left: 'left-0 border-r',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 overflow-hidden bg-black/30 backdrop-blur-xs transition-opacity"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={drawerRef}
        tabIndex={-1}
        className={`fixed inset-y-0 ${sideStyles[side]} w-full ${sizeStyles[size]} bg-[var(--surface-primary)] border-[var(--border-subtle)] shadow-modal flex flex-col focus:outline-none transition-transform duration-200 ease-in-out ${className}`}
      >
        {(title || description) && (
          <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3 shrink-0">
            <div>
              {title && (
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {title}
                </h2>
              )}
              {description && (
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                  {description}
                </p>
              )}
            </div>
            <IconButton
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Đóng bảng"
            >
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 text-xs">{children}</div>

        {footer && (
          <div className="px-5 py-3.5 bg-[var(--surface-secondary)] border-t border-[var(--border-subtle)] flex items-center justify-end gap-2.5 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
