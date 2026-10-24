'use client';

import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'subtle' | 'muted';
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ children, className = '', variant = 'default', ...props }, ref) => {
    const variantStyles = {
      default:
        'bg-[var(--surface-primary)] border border-[var(--border-subtle)] shadow-xs',
      subtle:
        'bg-[var(--surface-secondary)] border border-[var(--border-subtle)]',
      muted:
        'bg-[var(--surface-tertiary)] border border-[var(--border-subtle)]',
    };

    return (
      <div
        ref={ref}
        className={`rounded-xl overflow-hidden transition-shadow ${variantStyles[variant]} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ children, className = '', ...props }, ref) => (
  <div
    ref={ref}
    className={`px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-4 ${className}`}
    {...props}
  >
    {children}
  </div>
));
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ children, className = '', ...props }, ref) => (
  <h3
    ref={ref}
    className={`text-sm font-semibold text-[var(--text-primary)] tracking-tight ${className}`}
    {...props}
  >
    {children}
  </h3>
));
CardTitle.displayName = 'CardTitle';

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ children, className = '', ...props }, ref) => (
  <p
    ref={ref}
    className={`text-xs text-[var(--text-secondary)] mt-0.5 ${className}`}
    {...props}
  >
    {children}
  </p>
));
CardDescription.displayName = 'CardDescription';

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ children, className = '', ...props }, ref) => (
  <div ref={ref} className={`p-5 ${className}`} {...props}>
    {children}
  </div>
));
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ children, className = '', ...props }, ref) => (
  <div
    ref={ref}
    className={`px-5 py-3.5 bg-[var(--surface-secondary)] border-t border-[var(--border-subtle)] flex items-center justify-between gap-3 text-xs ${className}`}
    {...props}
  >
    {children}
  </div>
));
CardFooter.displayName = 'CardFooter';

export const Surface = Card;
