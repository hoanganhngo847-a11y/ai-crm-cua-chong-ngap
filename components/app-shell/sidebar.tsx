'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Inbox,
  Users,
  Phone,
  Cpu,
  Settings,
  Share2,
  ChevronLeft,
  ChevronRight,
  Search,
  Sparkles,
  KanbanSquare,
} from 'lucide-react';
import { Avatar } from '../ui/avatar';
import { Tooltip } from '../ui/tooltip';

export interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
  badge?: string | number;
  roles?: string[];
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export interface SidebarProps {
  userRole?: string | null;
  userName: string;
  userEmail: string;
  companyName?: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenCommandPalette: () => void;
  onNavigate?: () => void;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  userRole = 'SALE',
  userName,
  userEmail,
  companyName = 'Cửa Chống Ngập',
  isCollapsed,
  onToggleCollapse,
  onOpenCommandPalette,
  onNavigate,
  className = '',
}) => {
  const currentRole = userRole || 'SALE';
  const pathname = usePathname();

  const sections: NavSection[] = [
    {
      title: 'Kinh doanh & CRM',
      items: [
        {
          label: 'CRM',
          href: '/crm',
          icon: <LayoutDashboard className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN', 'SALE'],
        },
        {
          label: 'Phễu Kanban',
          href: '/crm/pipeline',
          icon: <KanbanSquare className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN', 'SALE'],
        },
        {
          label: 'Hộp thư (Inbox)',
          href: '/inbox',
          icon: <Inbox className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN', 'SALE'],
        },
        {
          label: 'Khách hàng 360',
          href: '/customers/dossier',
          icon: <Users className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN', 'SALE'],
        },
        { label: 'Chiến dịch tin nhắn', href: '/campaigns', icon: <Share2 className="w-4 h-4 shrink-0" />, roles: ['BOSS_ADMIN', 'SALE'] },
        {
          label: 'Cuộc gọi & Ghi âm',
          href: '/calls',
          icon: <Phone className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN', 'SALE'],
        },
      ],
    },
    {
      title: 'Trí tuệ nhân tạo (AI)',
      items: [
        {
          label: 'AI Control Center',
          href: '/admin/ai',
          icon: <Cpu className="w-4 h-4 shrink-0 text-indigo-600" />,
          roles: ['BOSS_ADMIN'],
        },
      ],
    },
    {
      title: 'Quản trị hệ thống',
      items: [
        {
          label: 'Cấu hình hệ thống',
          href: '/admin',
          icon: <Settings className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN'],
        },
        {
          label: 'Kết nối Facebook',
          href: '/admin/facebook',
          icon: <Share2 className="w-4 h-4 shrink-0" />,
          roles: ['BOSS_ADMIN'],
        },
      ],
    },
  ];

  const isItemActive = (href: string) => {
    if (href === '/crm' && pathname === '/crm') return true;
    if (href === '/customers/dossier' && (pathname?.startsWith('/customers') || pathname === '/customers/dossier')) return true;
    if (href === '/calls' && pathname?.startsWith('/calls')) return true;
    if (href === '/admin' && pathname === '/admin') return true;
    if (href === '/admin/ai' && pathname?.startsWith('/admin/ai')) return true;
    if (href === '/admin/facebook' && pathname?.startsWith('/admin/facebook')) return true;
    if (href !== '/crm' && href !== '/admin' && pathname?.startsWith(href)) return true;
    return false;
  };

  return (
    <aside
      className={`h-screen sticky top-0 flex flex-col bg-[var(--surface-primary)] border-r border-[var(--border-subtle)] transition-[width] duration-200 ease-in-out shrink-0 select-none z-30 ${
        isCollapsed ? 'w-14' : 'w-60'
      } ${className}`}
    >
      {/* Workspace Header */}
      <div className="h-14 px-3 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
        {!isCollapsed && (
          <Link href="/crm" onClick={onNavigate} className="flex items-center gap-2.5 min-w-0 group">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent)] flex items-center justify-center text-white shrink-0 shadow-xs">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                {companyName}
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wider font-mono">
                AI CRM Suite
              </div>
            </div>
          </Link>
        )}

        {isCollapsed && (
          <Link href="/crm" onClick={onNavigate} className="mx-auto" title={companyName}>
            <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center text-white shadow-xs">
              <Sparkles className="w-4 h-4" />
            </div>
          </Link>
        )}

        <button
          type="button"
          onClick={onToggleCollapse}
          className={`hidden md:flex p-1 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer ${
            isCollapsed ? 'mx-auto mt-2' : ''
          }`}
          aria-label={isCollapsed ? 'Mở rộng sidebar' : 'Thu gọn sidebar'}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronLeft className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Quick Search / ⌘K Trigger Button */}
      <div className="p-2 shrink-0">
        {isCollapsed ? (
          <Tooltip content="Tìm kiếm nhanh (⌘K)" position="right">
            <button
              type="button"
              onClick={onOpenCommandPalette}
              className="w-10 h-8 mx-auto flex items-center justify-center rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              aria-label="Tìm kiếm nhanh"
            >
              <Search className="w-4 h-4" />
            </button>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="w-full h-8 px-2.5 flex items-center justify-between rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-secondary)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] transition-colors text-xs cursor-pointer group"
          >
            <div className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]" />
              <span>Tìm kiếm nhanh...</span>
            </div>
            <kbd className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--surface-primary)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] shadow-xs">
              ⌘K
            </kbd>
          </button>
        )}
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-4">
        {sections.map((section, sIdx) => {
          const visibleItems = section.items.filter((item) => {
            if (!item.roles) return true;
            return item.roles.includes(currentRole);
          });

          if (visibleItems.length === 0) return null;

          return (
            <div key={sIdx} className="space-y-0.5">
              {!isCollapsed && section.title && (
                <div className="px-2.5 py-1 text-[11px] font-medium text-[var(--text-tertiary)] tracking-wider uppercase">
                  {section.title}
                </div>
              )}

              {visibleItems.map((item) => {
                const active = isItemActive(item.href);

                const linkContent = (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors relative group ${
                      active
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                    } ${isCollapsed ? 'justify-center px-0' : ''}`}
                  >
                    <span
                      className={`transition-colors ${
                        active
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {item.icon}
                    </span>

                    {!isCollapsed && (
                      <span className="truncate flex-1">{item.label}</span>
                    )}

                    {!isCollapsed && item.badge && (
                      <span className="px-1.5 py-0.2 text-[10px] rounded-full font-mono bg-[var(--surface-secondary)] text-[var(--text-secondary)]">
                        {item.badge}
                      </span>
                    )}

                    {active && (
                      <span
                        className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-[var(--accent)] rounded-r-full"
                        aria-hidden="true"
                      />
                    )}
                  </Link>
                );

                if (isCollapsed) {
                  return (
                    <Tooltip key={item.href} content={item.label} position="right">
                      {linkContent}
                    </Tooltip>
                  );
                }

                return linkContent;
              })}
            </div>
          );
        })}
      </div>

      {/* User Profile & Account Footer */}
      <div className="p-2 border-t border-[var(--border-subtle)] shrink-0">
        <Link
          href="/account"
          onClick={onNavigate}
          className={`flex items-center gap-2.5 p-1.5 rounded-lg hover:bg-[var(--surface-hover)] transition-colors group ${
            isCollapsed ? 'justify-center' : ''
          }`}
          title={isCollapsed ? `${userName} (${userRole})` : undefined}
        >
          <Avatar name={userName || userEmail} size={isCollapsed ? 'sm' : 'sm'} />

          {!isCollapsed && (
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[var(--text-primary)] truncate group-hover:text-[var(--accent)]">
                {userName || userEmail}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono font-medium text-[var(--accent)]">
                  {userRole}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)] truncate">
                  • Cài đặt
                </span>
              </div>
            </div>
          )}
        </Link>
      </div>
    </aside>
  );
};
