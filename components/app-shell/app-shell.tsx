'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';
import { Drawer } from '../ui/drawer';
import { CommandPalette } from '../ui/command-palette';
import { ToastProvider } from '../ui/toast';

export interface AppShellProps {
  children: React.ReactNode;
  userRole?: string | null;
  userName: string;
  userEmail: string;
  companyName?: string;
  aal?: string;
}

interface AppShellContextValue {
  isFocusMode: boolean;
  setFocusMode: (value: boolean) => void;
  isSidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
}

const AppShellContext = createContext<AppShellContextValue>({
  isFocusMode: false,
  setFocusMode: () => undefined,
  isSidebarCollapsed: false,
  setSidebarCollapsed: () => undefined,
});

export function useAppShell() {
  return useContext(AppShellContext);
}

export const AppShell: React.FC<AppShellProps> = ({
  children,
  userRole,
  userName,
  userEmail,
  companyName = 'Cửa Chống Ngập',
  aal,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const pathname = usePathname();
  const [prevPathname, setPrevPathname] = useState(pathname);
  const isInbox = Boolean(pathname?.startsWith('/inbox'));

  // Keep route-derived UI resets in the existing route-change render guard so
  // we do not synchronously cascade setState calls from an effect.
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setIsMobileMenuOpen(false);
    if (isInbox) {
      setIsCollapsed(true);
    } else {
      setIsFocusMode(false);
    }
  }

  // Global Keyboard Shortcut: ⌘K or Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const mainClassName = isFocusMode
    ? 'flex-1 min-h-0 p-0 w-full overflow-hidden'
    : isInbox
      ? 'flex-1 min-h-0 p-0 w-full overflow-hidden'
      : 'flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto';

  return (
    <AppShellContext.Provider
      value={{
        isFocusMode,
        setFocusMode: setIsFocusMode,
        isSidebarCollapsed: isCollapsed,
        setSidebarCollapsed: setIsCollapsed,
      }}
    >
      <ToastProvider>
        <div
          className={`${isFocusMode || isInbox ? 'h-screen overflow-hidden' : 'min-h-screen'} flex bg-[var(--app-canvas)] text-[var(--text-primary)]`}
        >
          {/* Desktop Left Navigation Sidebar */}
          {!isFocusMode && (
            <div className="hidden md:block shrink-0">
              <Sidebar
                userRole={userRole}
                userName={userName}
                userEmail={userEmail}
                companyName={companyName}
                isCollapsed={isCollapsed}
                onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
                onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
              />
            </div>
          )}

          {/* Mobile Navigation Drawer */}
          {!isFocusMode && (
            <Drawer
              isOpen={isMobileMenuOpen}
              onClose={() => setIsMobileMenuOpen(false)}
              side="left"
              size="sm"
              className="p-0"
            >
              <div className="h-full flex flex-col">
                <Sidebar
                  userRole={userRole}
                  userName={userName}
                  userEmail={userEmail}
                  companyName={companyName}
                  isCollapsed={false}
                  onToggleCollapse={() => setIsMobileMenuOpen(false)}
                  onOpenCommandPalette={() => {
                    setIsMobileMenuOpen(false);
                    setIsCommandPaletteOpen(true);
                  }}
                  onNavigate={() => setIsMobileMenuOpen(false)}
                  className="w-full border-r-0 h-full"
                />
              </div>
            </Drawer>
          )}

          {/* Main Content Workspace */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {!isFocusMode && (
              <TopBar
                onOpenMobileMenu={() => setIsMobileMenuOpen(true)}
                onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
                userName={userName}
                userRole={userRole}
                aal={aal}
              />
            )}

            <main className={mainClassName}>{children}</main>
          </div>

          {/* Global Command Palette */}
          <CommandPalette
            isOpen={isCommandPaletteOpen}
            onClose={() => setIsCommandPaletteOpen(false)}
            userRole={userRole}
          />
        </div>
      </ToastProvider>
    </AppShellContext.Provider>
  );
};
