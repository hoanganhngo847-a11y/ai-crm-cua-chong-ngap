"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Button } from "../../components/ui/button";

const STORAGE_KEY = "campaign:selected-customers";
const MAX_RECIPIENTS = 500;

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
  const [selected, setSelected] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const pageIds = useMemo(() => new Set(ids), [ids]);
  const selectedOnPage = selected.filter((id) => pageIds.has(id));

  // Customer selection is campaign authoring, not message delivery. Persist it
  // across Customer 360 filter/pagination reloads so applying a filter does not
  // silently discard the recipients the user already ticked.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setSelected(
            parsed
              .filter((value): value is string => typeof value === "string")
              .slice(0, MAX_RECIPIENTS),
          );
        }
      }
    } catch {
      // Storage is only a UX convenience; selection still works without it.
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    } catch {
      // Ignore storage failures and keep the in-memory selection.
    }
  }, [hydrated, selected]);

  const enabled = true;
  const clearStoredSelection = () => {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Navigation must not depend on sessionStorage availability.
    }
  };

  return (
    <Selection.Provider
      value={{
        ids,
        enabled,
        selected,
        toggle: (id) =>
          setSelected((old) => {
            if (old.includes(id)) return old.filter((value) => value !== id);
            if (old.length >= MAX_RECIPIENTS) return old;
            return [...old, id];
          }),
        all: () =>
          setSelected((old) => {
            const allCurrentSelected = ids.every((id) => old.includes(id));
            if (allCurrentSelected) {
              const current = new Set(ids);
              return old.filter((id) => !current.has(id));
            }
            return [...new Set([...old, ...ids])].slice(0, MAX_RECIPIENTS);
          }),
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
            onClick={clearStoredSelection}
          >
            <Button>Tiếp tục: chọn mẫu tin nhắn</Button>
          </Link>
          <Button
            variant="ghost"
            onClick={() => {
              setSelected([]);
              clearStoredSelection();
            }}
          >
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
