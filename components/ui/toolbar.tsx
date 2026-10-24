'use client';

import React from 'react';

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
}

export const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(
  ({ children, leftContent, rightContent, className = '', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 py-1 ${className}`}
        {...props}
      >
        {leftContent && (
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {leftContent}
          </div>
        )}
        {children && (
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {children}
          </div>
        )}
        {rightContent && (
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            {rightContent}
          </div>
        )}
      </div>
    );
  }
);
Toolbar.displayName = 'Toolbar';
