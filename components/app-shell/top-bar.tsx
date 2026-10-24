'use client';

import React from 'react';
import { Menu, Search, LogOut } from 'lucide-react';
import { IconButton } from '../ui/icon-button';
import { Badge } from '../ui/badge';
import { logoutAction } from '../../app/(auth)/actions';

export interface TopBarProps {
  onOpenMobileMenu: () => void;
  onOpenCommandPalette: () => void;
  userName: string;
  userRole?: string | null;
  aal?: string;
  className?: string;
}

export const TopBar: React.FC<TopBarProps> = ({
  onOpenMobileMenu,
  onOpenCommandPalette,
  userName,
  userRole = 'SALE',
  aal,
  className = '',
}) => {
  return (
    <header
      className={`h-14 px-4 sm:px-6 bg-[var(--surface-primary)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 sticky top-0 z-20 shrink-0 ${className}`}
    >
      <div className="flex items-center gap-3">
        {/* Mobile Hamburger Menu Toggle */}
        <IconButton
          variant="ghost"
          size="sm"
          onClick={onOpenMobileMenu}
          className="md:hidden"
          aria-label="Mở menu điều hướng"
        >
          <Menu className="w-5 h-5" />
        </IconButton>

        {/* Global Search Button */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="hidden sm:flex items-center gap-2 h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] transition-colors cursor-pointer group"
        >
          <Search className="w-3.5 h-3.5 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]" />
          <span>Tìm kiếm nhanh (⌘K)</span>
          <kbd className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--surface-primary)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] ml-1">
            ⌘K
          </kbd>
        </button>
      </div>

      <div className="flex items-center gap-3">
        {/* Role & Auth Level Info */}
        <div className="hidden sm:flex items-center gap-1.5">
          {userName && (
            <span className="text-xs font-medium text-[var(--text-secondary)] mr-1">
              {userName}
            </span>
          )}
          <Badge variant="accent" size="xs">
            {userRole}
          </Badge>
          {aal && (
            <Badge variant="success" size="xs">
              {aal.toUpperCase()}
            </Badge>
          )}
        </div>

        {/* Logout Button (Preserving #header-logout-button for test and auth safety) */}
        <form action={logoutAction}>
          <button
            id="header-logout-button"
            type="submit"
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-primary)] text-xs text-[var(--text-secondary)] hover:text-[var(--danger)] hover:border-[var(--danger-border)] hover:bg-[var(--danger-surface)] transition-colors cursor-pointer"
            title="Đăng xuất khỏi hệ thống"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Đăng xuất</span>
          </button>
        </form>
      </div>
    </header>
  );
};
