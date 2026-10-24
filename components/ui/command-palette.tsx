'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  LayoutDashboard,
  Inbox,
  Users,
  Phone,
  FileSpreadsheet,
  ShoppingCart,
  FileCheck,
  Cpu,
  Shield,
  Settings,
  X,
} from 'lucide-react';

interface CommandItem {
  id: string;
  title: string;
  description?: string;
  category: 'Điều hướng' | 'Khách hàng' | 'Thao tác';
  icon: React.ReactNode;
  href?: string;
  onSelect?: () => void;
  roles?: string[];
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  userRole?: string | null;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  userRole = 'BOSS_ADMIN',
}) => {
  const currentRole = userRole || 'BOSS_ADMIN';
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const baseCommands: CommandItem[] = [
    {
      id: 'nav-crm',
      title: 'CRM Tổng quan',
      description: 'Bảng điều khiển kinh doanh và khách hàng tiềm năng',
      category: 'Điều hướng',
      icon: <LayoutDashboard className="w-4 h-4 text-blue-600" />,
      href: '/crm',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-inbox',
      title: 'Hộp thư Đa kênh (Inbox)',
      description: 'Tin nhắn Zalo, Facebook Messenger và trực tiếp',
      category: 'Điều hướng',
      icon: <Inbox className="w-4 h-4 text-indigo-600" />,
      href: '/inbox',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-customers',
      title: 'Hồ sơ Khách hàng 360',
      description: 'Danh sách hồ sơ khách hàng và AI dossier',
      category: 'Điều hướng',
      icon: <Users className="w-4 h-4 text-emerald-600" />,
      href: '/customers/dossier',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-calls',
      title: 'Ghi âm & Cuộc gọi (Calls)',
      description: 'Lịch sử cuộc gọi, nghe lại ghi âm và tóm tắt AI',
      category: 'Điều hướng',
      icon: <Phone className="w-4 h-4 text-teal-600" />,
      href: '/calls',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-quotations',
      title: 'Báo giá',
      description: 'Quản lý bảng tính giá và phương án kỹ thuật',
      category: 'Điều hướng',
      icon: <FileSpreadsheet className="w-4 h-4 text-sky-600" />,
      href: '/quotations',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-orders',
      title: 'Đơn hàng',
      description: 'Theo dõi tiến độ đơn hàng và thanh toán',
      category: 'Điều hướng',
      icon: <ShoppingCart className="w-4 h-4 text-amber-600" />,
      href: '/orders',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-contracts',
      title: 'Hợp đồng',
      description: 'Hợp đồng kinh tế và cam kết chống ngập',
      category: 'Điều hướng',
      icon: <FileCheck className="w-4 h-4 text-purple-600" />,
      href: '/contracts',
      roles: ['BOSS_ADMIN', 'SALE'],
    },
    {
      id: 'nav-ai-control',
      title: 'AI Control Center',
      description: 'Giám sát Javis AI Brain, Live channels và Kill-switch',
      category: 'Điều hướng',
      icon: <Cpu className="w-4 h-4 text-rose-600" />,
      href: '/admin/ai',
      roles: ['BOSS_ADMIN'],
    },
    {
      id: 'nav-admin',
      title: 'Quản trị hệ thống',
      description: 'Phân quyền, cấu hình công ty và bảo mật MFA',
      category: 'Điều hướng',
      icon: <Shield className="w-4 h-4 text-slate-700" />,
      href: '/admin',
      roles: ['BOSS_ADMIN'],
    },
    {
      id: 'nav-account',
      title: 'Cài đặt tài khoản',
      description: 'Thông tin cá nhân và phiên đăng nhập',
      category: 'Điều hướng',
      icon: <Settings className="w-4 h-4 text-slate-600" />,
      href: '/account',
    },
  ];

  const allowedCommands = baseCommands.filter((cmd) => {
    if (!cmd.roles) return true;
    return cmd.roles.includes(currentRole);
  });

  const filteredCommands = allowedCommands.filter((cmd) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      cmd.title.toLowerCase().includes(q) ||
      (cmd.description && cmd.description.toLowerCase().includes(q))
    );
  });

  useEffect(() => {
    if (isOpen) {
      previousFocus.current = document.activeElement as HTMLElement;
      const timer = setTimeout(() => {
        setQuery('');
        setSelectedIndex(0);
        inputRef.current?.focus();
      }, 0);
      document.body.style.overflow = 'hidden';

      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          return;
        }

        if (e.key === 'Tab') {
          const dialog = dialogRef.current;
          if (!dialog) return;

          const focusableElements = dialog.querySelectorAll<HTMLElement>(
            'input, button, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          const focusable = Array.from(focusableElements).filter(
            (el) => !el.hasAttribute('disabled') && el.offsetParent !== null
          );

          if (focusable.length === 0) {
            e.preventDefault();
            return;
          }

          const first = focusable[0];
          const last = focusable[focusable.length - 1];

          if (e.shiftKey) {
            if (document.activeElement === first || !dialog.contains(document.activeElement)) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last || !dialog.contains(document.activeElement)) {
              e.preventDefault();
              first.focus();
            }
          }
        }
      };

      window.addEventListener('keydown', handleGlobalKeyDown);

      return () => {
        clearTimeout(timer);
        window.removeEventListener('keydown', handleGlobalKeyDown);
        document.body.style.overflow = '';
        previousFocus.current?.focus?.();
      };
    }
  }, [isOpen, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredCommands.length === 0) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) =>
        prev <= 0 ? filteredCommands.length - 1 : prev - 1
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filteredCommands[selectedIndex];
      if (selected) {
        executeCommand(selected);
      }
    }
  };

  const executeCommand = (command: CommandItem) => {
    onClose();
    if (command.href) {
      router.push(command.href);
    } else if (command.onSelect) {
      command.onSelect();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tìm kiếm nhanh hoặc điều hướng"
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 sm:pt-24 p-4 bg-black/40 backdrop-blur-xs animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-lg bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-xl shadow-modal overflow-hidden flex flex-col focus:outline-none animate-in zoom-in-95 duration-150"
      >
        {/* Search Input Bar */}
        <div className="flex items-center px-3.5 py-2.5 border-b border-[var(--border-subtle)] gap-2.5">
          <Search className="w-4 h-4 text-[var(--text-tertiary)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-autocomplete="list"
            aria-activedescendant={
              filteredCommands[selectedIndex]
                ? `cmd-option-${filteredCommands[selectedIndex].id}`
                : undefined
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Tìm tính năng, khách hàng, trang... (gõ để tìm)"
            className="w-full bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] focus:outline-none"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              aria-label="Xóa từ khóa tìm kiếm"
              className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <span className="text-[10px] font-mono border border-[var(--border-subtle)] px-1.5 py-0.5 rounded bg-[var(--surface-secondary)] text-[var(--text-tertiary)]">
              ESC
            </span>
          )}
        </div>

        {/* Results List */}
        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          aria-label="Danh sách kết quả tìm kiếm"
          className="max-h-80 overflow-y-auto p-2 divide-y divide-[var(--border-subtle)]/50"
        >
          {filteredCommands.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--text-tertiary)]">
              Không tìm thấy lệnh hoặc trang nào khớp với &ldquo;{query}&rdquo;
            </div>
          ) : (
            filteredCommands.map((cmd, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={cmd.id}
                  id={`cmd-option-${cmd.id}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => executeCommand(cmd)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-xs cursor-pointer transition-colors ${
                    isSelected
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`p-1.5 rounded-md ${
                        isSelected
                          ? 'bg-white shadow-xs'
                          : 'bg-[var(--surface-secondary)]'
                      }`}
                    >
                      {cmd.icon}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--text-primary)] truncate">
                        {cmd.title}
                      </div>
                      {cmd.description && (
                        <div className="text-[11px] text-[var(--text-secondary)] truncate">
                          {cmd.description}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 text-[11px] text-[var(--text-tertiary)]">
                    <span className="text-[10px] uppercase font-mono px-1 rounded bg-[var(--surface-secondary)]">
                      {cmd.category}
                    </span>
                    {isSelected && (
                      <span className="text-[10px] font-mono text-[var(--accent)] flex items-center gap-0.5">
                        ↵ Chọn
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer info */}
        <div className="px-3.5 py-2 bg-[var(--surface-secondary)] border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-tertiary)]">
          <div className="flex items-center gap-2">
            <span>
              Dùng <kbd className="font-mono font-semibold">↑</kbd>{' '}
              <kbd className="font-mono font-semibold">↓</kbd> để di chuyển
            </span>
            <span>•</span>
            <span>
              <kbd className="font-mono font-semibold">↵</kbd> để mở
            </span>
          </div>
          <span>Cửa Chống Ngap CRM</span>
        </div>
      </div>
    </div>
  );
};
