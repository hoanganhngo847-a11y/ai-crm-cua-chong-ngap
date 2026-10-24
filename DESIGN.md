# AI CRM DESIGN SYSTEM (Attio & Linear Inspired)

> Source of Truth for UX/UI Architecture, Design Tokens, Components, and Interaction Standards.

---

## 1. Visual References & Philosophy

- **Primary Product Reference — Attio CRM**:
  - Left navigation sidebar recedes cleanly into background.
  - Wide, calm, distraction-free canvas (`#f7f8fa`).
  - High-density data tables as central operational artifacts.
  - Contextual drawers/side panels for detail exploration instead of invasive modal dialogs.
  - Search, filters, and view controls positioned adjacent to data.
  - Dense, productive, yet visually uncrowded and scanning-friendly.

- **Secondary Product Reference — Linear**:
  - Consistent header and toolbar ergonomics across all modules.
  - Hairline borders (`1px solid var(--border-subtle)`).
  - Restrained typography weights (medium 500-600 headers, 400 body).
  - Keyboard-first shortcuts (global Command Palette `⌘K` / `Ctrl+K`, ESC dismiss, arrow navigation).
  - Near-zero visual decoration; color is functional, never decorative.

- **Tertiary Visual References — Seline & Stripe**:
  - Light-first primary experience.
  - Crisp white cards and surfaces (`#ffffff`).
  - Ultra-subtle elevation and shadows.
  - Single primary accent (`#3b82f6` blue) for interaction and focus.

---

## 2. Design Principles

1. **Clarity over Flashiness**: No artificial AI dashboard tropes (no neon gradients, no heavy glassmorphism, no bloated metrics cards, no random bento grids).
2. **Scanning Speed**: Clear typographic hierarchy, right-aligned numbers, monospaced codes/timestamps, sticky table headers.
3. **Workflow Speed**: Quick drawer inspection, inline actions, persistent search, keyboard command palette.
4. **Consistency**: Reusable UI component primitives; zero ad-hoc Tailwind color declarations (`bg-slate-900`, `text-slate-400`).
5. **Aesthetics through Restraint**: 4px rhythmic spacing, subtle borders, disciplined status badge palette.

---

## 3. Design Tokens (Tailwind v4 & CSS Variables)

```css
:root {
  /* Canvas & Surfaces */
  --app-canvas: #f8f9fb;
  --surface-primary: #ffffff;
  --surface-secondary: #f4f5f8;
  --surface-tertiary: #ebedf2;
  --surface-hover: #f1f3f7;
  --surface-active: #e7eaf0;

  /* Borders */
  --border-subtle: #e6e8ee;
  --border-strong: #d2d5de;
  --border-focus: #3b82f6;

  /* Typography */
  --text-primary: #121417;
  --text-secondary: #565d6d;
  --text-tertiary: #8b92a2;
  --text-disabled: #b5b9c5;
  --text-inverse: #ffffff;

  /* Brand & Primary Interactive */
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-soft: #eff6ff;
  --accent-border: #bfdbfe;

  /* Semantic Status */
  --success: #15803d;
  --success-surface: #f0fdf4;
  --success-border: #bbf7d0;

  --warning: #b45309;
  --warning-surface: #fffbeb;
  --warning-border: #fde68a;

  --danger: #b91c1c;
  --danger-surface: #fef2f2;
  --danger-border: #fecaca;

  --info: #0369a1;
  --info-surface: #f0f9ff;
  --info-border: #bae6fd;

  --ai: #6366f1;
  --ai-surface: #eef2ff;
  --ai-border: #c7d2fe;

  --human: #d97706;
  --human-surface: #fffbeb;
  --human-border: #fef3c7;
}
```

---

## 4. Typography Scale

- **Font Family**:
  - UI / Body: `Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
  - Technical / IDs / Codes / Timestamps: `Geist Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace`
- **Type Scale**:
  - Desktop Page Title: `20px–22px` (`font-semibold`, tracking `-0.02em`)
  - Section Title: `15px–16px` (`font-semibold`, tracking `-0.01em`)
  - Body Text: `14px` (`font-normal`, line-height `1.5`)
  - Table Cells: `13px–14px` (`font-normal`)
  - Metadata / Captions / Badges: `12px` (`font-medium`)
  - Micro / Keyboard Badges: `11px` (`font-mono`)

---

## 5. Spacing, Radius, and Elevation

- **4px Spatial Grid**: `4px (1)`, `8px (2)`, `12px (3)`, `16px (4)`, `20px (5)`, `24px (6)`, `32px (8)`, `48px (12)`.
- **Corner Radii**:
  - Cards, Sheets & Modals: `10px`–`12px` (`rounded-xl`)
  - Buttons, Inputs, Menus: `6px`–`8px` (`rounded-lg`)
  - Badges, Chips, Avatars: `9999px` (`rounded-full`)
- **Shadows**:
  - Flat / Borders first: Hairline `1px solid var(--border-subtle)`
  - Elevated / Popovers / Modals: `0 4px 12px -2px rgba(16, 24, 40, 0.08), 0 2px 4px -2px rgba(16, 24, 40, 0.04)`

---

## 6. App Shell & Navigation

- **Desktop Shell**:
  - Persistent left sidebar: `240px` (or collapsed `56px`).
  - Top header: Lightweight `h-14` breadcrumb + global search trigger (`⌘K`) + user profile & notifications.
  - Content canvas: Flexible, wide container with standard max-width or full-width data tables.
- **Mobile / Tablet Shell**:
  - Mobile header with hamburger menu button.
  - Slide-in Drawer (`w-72`) displaying full authorized navigation.
  - Content area responsive down to `360px` with horizontal table scroll and stacked layouts.
- **Role-Based Menus (Strict Server Authority preserved)**:
  - `BOSS_ADMIN`: CRM, Inbox, Customers, Calls, Quotations, Orders, Contracts, Production, Field, Warranty, Admin, AI Control, Facebook, Account.
  - `SALE`: CRM, Inbox, Customers, Calls, Quotations, Orders, Contracts, Warranty, Account.
  - `TECHNICIAN`: Field, Warranty, Account.

---

## 7. Global Page Header Component

Every module implements a unified page header pattern:
```
[Breadcrumb / Location]
[Page Title (20px)]                [Secondary Actions] [Primary Action Button]
[Optional Subtitle / Description]
[View Toolbar: Search, Filters, Grouping, View Mode]
```

---

## 8. Command Palette (`⌘K` / `Ctrl+K`)

- Activated globally via shortcut or top header search button.
- Instant routing to:
  - CRM Home, Inbox, Customer 360, Calls, Orders, Quotations, Contracts, Field, Production, Warranty, AI Control, Admin.
- Customer search with instant debounced lookup.
- Full keyboard navigation: Up/Down arrow selection, Enter execution, Esc dismiss.

---

## 9. Data Table Standards

- **Sticky Header**: `position: sticky; top: 0; z-index: 10; background: var(--surface-primary);`
- **Density**: Row height `40px`–`44px`, compact cell padding `px-3 py-2.5`.
- **Typography**: `13px` tabular figures for numbers (`font-mono` where appropriate).
- **Alignment**: Text left-aligned; Numbers/Currency/Quantities right-aligned; Status/Actions centered or right-aligned.
- **Subtle Row Hover**: `hover:bg-[var(--surface-hover)]`.
- **Actions Column**: Compact dropdown menu button (`...`) instead of 4 scattered buttons.
- **Empty & Loading States**: Clean skeleton loaders matching table geometry; distinct empty-state illustration/message with action.

---

## 10. Forms & Controls

- Form Fields always display:
  - Label (`13px`, `font-medium`, `var(--text-secondary)`)
  - Input/Select control (`h-9`, `px-3`, `rounded-md`, border `var(--border-subtle)`, focus ring `var(--accent)`)
  - Optional Helper / Error text (`12px`, `text-[var(--danger)]` on error)
- Explicit `aria-invalid` and `aria-describedby` linkage.
- Predictable primary button at bottom-right or top-right.

---

## 11. Customer 360 Dossier & Detail Architecture

- Two-column workspace inspired by Attio:
  - **Left / Main Column (65–70%)**:
    - AI Customer Snapshot & Freshness indicator.
    - Situational awareness: Current state, Intent, Pain points, Objections, Next actions.
    - Tabbed timeline / interactions (Calls, Messages, Stage history, AI notes).
  - **Right Rail (30–35%)**:
    - Customer identity cards: Masked phone (unmasked for BOSS_ADMIN only), Zalo ID, Facebook ID, Source.
    - Assigned sales rep & lifecycle stage dropdown.
    - Engagement metrics & key metadata.

---

## 12. Accessibility & Motion

- Restrained animations: `150ms`–`200ms`, `ease-out`, opacity and slight translateY.
- Strict WCAG AA contrast for text and interactive controls.
- Keyboard accessible dialogs, drawers, and command palette with focus trap and focus restore.
- Reduced motion support: `@media (prefers-reduced-motion: reduce)` disables non-essential transitions.
