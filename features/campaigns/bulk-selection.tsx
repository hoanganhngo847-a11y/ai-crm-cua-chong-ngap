"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Button } from "../../components/ui/button";

const STORAGE_KEY = "campaign:selected-customers";
const STORAGE_EVENT = "campaign-selection-change";
const MAX_RECIPIENTS = 500;

function subscribeSelection(onStoreChange: () => void) {
  window.addEventListener(STORAGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(STORAGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function selectionSnapshot() {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) || "[]";
  } catch {
    return "[]";
  }
}

function parseSelection(snapshot: string): string[] {
  try {
    const parsed = JSON.parse(snapshot);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string")
      .slice(0, MAX_RECIPIENTS);
  } catch {
    return [];
  }
}

function writeSelection(selected: string[]) {
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(selected.slice(0, MAX_RECIPIENTS)),
    );
    window.dispatchEvent(new Event(STORAGE_EVENT));
  } catch {
    // Storage is a UX convenience; no delivery behavior depends on it.
  }
}

function clearSelection() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(STORAGE_EVENT));
  } catch {
    // Navigation must not depend on sessionStorage availability.
  }
}

const Selection = createContext<{
  enabled: boolean;
  selected: string[];
  ids: string[];
  toggle: (id: string) => void;
  all: () => void;
}>({ enabled: false, selected: [], ids: [], toggle() {}, all() {} });

export function BulkSelection({
  ids,
  children,
}: {
  ids: string[];
  enabled?: boolean;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    subscribeSelection,
    selectionSnapshot,
    () => "[]",
  );
  const selected = parseSelection(snapshot);
  const enabled = true;

  return (
    <Selection.Provider
      value={{
        ids,
        enabled,
        selected,
        toggle: (id) => {
          if (selected.includes(id)) {
            writeSelection(selected.filter((value) => value !== id));
            return;
          }
          if (selected.length >= MAX_RECIPIENTS) return;
          writeSelection([...selected, id]);
        },
        all: () => {
          const allCurrentSelected = ids.every((id) => selected.includes(id));
          if (allCurrentSelected) {
            const current = new Set(ids);
            writeSelection(selected.filter((id) => !current.has(id)));
            return;
          }
          writeSelection(
            [...new Set([...selected, ...ids])].slice(0, MAX_RECIPIENTS),
          );
        },
      }}
    >
      {children}
      {selected.length > 0 && (
        <div
          className="sticky bottom-4 z-20 mx-auto flex w-fit flex-wrap items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-4 shadow-lg"
          role="status"
        >
          <div>
            <strong>{selected.length} khách hàng đã chọn</strong>
            <p className="text-xs text-[var(--text-secondary)]">
              Tiếp theo: chọn hoặc tạo mẫu tin nhắn.
            </p>
          </div>
          <Link
            href={`/campaigns/new?customers=${selected.join(",")}`}
            onClick={clearSelection}
          >
            <Button>Tiếp tục: chọn mẫu tin nhắn</Button>
          </Link>
          <Button variant="ghost" onClick={clearSelection}>
            Bỏ chọn
          </Button>
        </div>
      )}
    </Selection.Provider>
  );
}

export function BulkHeader() {
  const ctx = useContext(Selection);
  const allCurrentSelected =
    ctx.ids.length > 0 && ctx.ids.every((id) => ctx.selected.includes(id));
  return ctx.enabled ? (
    <th className="px-3">
      <input
        type="checkbox"
        aria-label="Chọn trang hiện tại"
        checked={allCurrentSelected}
        disabled={!ctx.ids.length}
        onChange={ctx.all}
      />
    </th>
  ) : null;
}

export function BulkCell({ id, name }: { id: string; name: string }) {
  const ctx = useContext(Selection);
  return ctx.enabled ? (
    <td className="px-3">
      <input
        type="checkbox"
        aria-label={`Chọn ${name}`}
        checked={ctx.selected.includes(id)}
        onChange={() => ctx.toggle(id)}
      />
    </td>
  ) : null;
}
