'use client';

import React from 'react';
import { FolderSearch, AlertCircle, ShieldAlert, Inbox, RotateCcw } from 'lucide-react';
import { Button } from './button';

export interface EmptyStateProps {
  type?: 'empty' | 'no-results' | 'error' | 'permission';
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  onRetry?: () => void;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  type = 'empty',
  title,
  description,
  icon,
  action,
  onRetry,
  className = '',
}) => {
  const defaults = {
    empty: {
      icon: <Inbox className="w-8 h-8 text-[var(--text-tertiary)]" />,
      title: 'Chưa có dữ liệu',
      description: 'Chưa có bản ghi nào được tạo trong danh mục này.',
    },
    'no-results': {
      icon: <FolderSearch className="w-8 h-8 text-[var(--text-tertiary)]" />,
      title: 'Không tìm thấy kết quả phù hợp',
      description: 'Thử kiểm tra lại từ khóa hoặc điều chỉnh bộ lọc tìm kiếm.',
    },
    error: {
      icon: <AlertCircle className="w-8 h-8 text-[var(--danger)]" />,
      title: 'Không thể tải dữ liệu',
      description: 'Đã xảy ra sự cố khi kết nối. Vui lòng thử lại.',
    },
    permission: {
      icon: <ShieldAlert className="w-8 h-8 text-[var(--warning)]" />,
      title: 'Không có quyền truy cập',
      description: 'Tài khoản của bạn không được phân quyền xem nội dung này.',
    },
  };

  const currentDefaults = defaults[type];
  const finalTitle = title || currentDefaults.title;
  const finalDescription = description || currentDefaults.description;
  const finalIcon = icon || currentDefaults.icon;

  return (
    <div
      className={`flex flex-col items-center justify-center p-8 sm:p-12 text-center rounded-xl border border-dashed border-[var(--border-subtle)] bg-[var(--surface-primary)] ${className}`}
    >
      <div className="p-3 mb-3 rounded-full bg-[var(--surface-secondary)] border border-[var(--border-subtle)]">
        {finalIcon}
      </div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
        {finalTitle}
      </h3>
      <p className="text-xs text-[var(--text-secondary)] max-w-sm mb-4 leading-relaxed">
        {finalDescription}
      </p>

      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
        >
          Thử lại
        </Button>
      )}

      {action && (
        <Button
          variant="primary"
          size="sm"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
};
