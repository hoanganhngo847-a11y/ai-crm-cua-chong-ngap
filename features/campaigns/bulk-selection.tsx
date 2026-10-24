"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "../../components/ui/button";
const Selection = createContext<{
  enabled: boolean;
  selected: string[];
  ids: string[];
  toggle: (id: string) => void;
  all: () => void;
}>({ enabled: false, selected: [], ids: [], toggle() {}, all() {} });
export function BulkSelection({
  ids,
  enabled,
  children,
}: {
  ids: string[];
  enabled: boolean;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <Selection.Provider
      value={{
        ids,
        enabled,
        selected,
        toggle: (id) =>
          setSelected((old) =>
            old.includes(id) ? old.filter((v) => v !== id) : [...old, id],
          ),
        all: () => setSelected((old) => (old.length === ids.length ? [] : ids)),
      }}
    >
      {children}
      {enabled && selected.length > 0 && (
        <div
          className="sticky bottom-4 z-20 mx-auto flex w-fit items-center gap-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-primary)] p-4 shadow-lg"
          role="status"
        >
          <strong>{selected.length} khách hàng đã chọn</strong>
          <Link href={`/campaigns/new?customers=${selected.join(",")}`}>
            <Button>Gửi tin nhắn</Button>
          </Link>
          <Button variant="ghost" onClick={() => setSelected([])}>
            Bỏ chọn
          </Button>
        </div>
      )}
    </Selection.Provider>
  );
}
export function BulkHeader() {
  const ctx = useContext(Selection);
  return ctx.enabled ? (
    <th className="px-3">
      <input
        type="checkbox"
        aria-label="Chọn trang hiện tại"
        checked={ctx.ids.length > 0 && ctx.selected.length === ctx.ids.length}
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
