'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface ToastContextType {
  toast: (message: string, type?: ToastItem['type']) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastItem['type'] = 'info') => {
      const id = Math.random().toString(36).substring(2, 9);
      setToasts((prev) => [...prev, { id, type, message }]);
      setTimeout(() => removeToast(id), 4000);
    },
    [removeToast]
  );

  const value = {
    toast: addToast,
    success: (msg: string) => addToast(msg, 'success'),
    error: (msg: string) => addToast(msg, 'error'),
    info: (msg: string) => addToast(msg, 'info'),
  };

  const icons = {
    success: <CheckCircle2 className="w-4 h-4 text-[var(--success)] shrink-0" />,
    error: <AlertCircle className="w-4 h-4 text-[var(--danger)] shrink-0" />,
    info: <Info className="w-4 h-4 text-[var(--info)] shrink-0" />,
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between gap-3 p-3 bg-[var(--surface-primary)] border border-[var(--border-subtle)] rounded-lg shadow-modal text-xs pointer-events-auto animate-in slide-in-from-bottom-2 duration-150"
          >
            <div className="flex items-center gap-2.5">
              {icons[t.type]}
              <span className="text-[var(--text-primary)] font-medium">
                {t.message}
              </span>
            </div>
            <button
              onClick={() => removeToast(t.id)}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] p-0.5 rounded cursor-pointer"
              aria-label="Đóng thông báo"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    // Fallback if not inside ToastProvider
    return {
      toast: (msg: string) => console.log(msg),
      success: (msg: string) => console.log('Success:', msg),
      error: (msg: string) => console.error('Error:', msg),
      info: (msg: string) => console.log('Info:', msg),
    };
  }
  return context;
};
