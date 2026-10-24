'use client';

import React, { useState, useEffect } from 'react';
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

export const AppShell: React.FC<AppShellProps> = ({
  children,
  userRole,
  userName,
  userEmail,
  companyName = 'Cửa Chống Ngập',
  aal,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);

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

  return (
    <ToastProvider>
      <div className="min-h-screen flex bg-[var(--app-canvas)] text-[var(--text-primary)]">
        {/* Desktop Left Navigation Sidebar */}
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

        {/* Mobile Navigation Drawer */}
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
              className="w-full border-r-0 h-full"
            />
          </div>
        </Drawer>

        {/* Main Content Workspace */}
        <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
          <TopBar
            onOpenMobileMenu={() => setIsMobileMenuOpen(true)}
            onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
            userName={userName}
            userRole={userRole}
            aal={aal}
          />

          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
            {children}
          </main>
        </div>

        {/* Global Command Palette */}
        <CommandPalette
          isOpen={isCommandPaletteOpen}
          onClose={() => setIsCommandPaletteOpen(false)}
          userRole={userRole}
        />
      </div>
    </ToastProvider>
  );
};
