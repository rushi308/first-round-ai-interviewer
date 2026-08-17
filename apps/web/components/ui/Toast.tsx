"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type ToastKind = "success" | "error";

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
};

type ToastApi = {
  push: (kind: ToastKind, title: string, body?: string) => void;
  success: (title: string, body?: string) => void;
  error: (title: string, body?: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, title, body }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3200);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, body) => push("success", title, body),
      error: (title, body) => push("error", title, body),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-5 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-[22px] border border-[var(--studio-line)] bg-[var(--studio-panel)] px-4 py-3 text-white shadow-[0_12px_40px_rgba(0,0,0,0.35)]"
          >
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
              style={{ background: t.kind === "success" ? "var(--accent)" : "var(--bad)" }}
            >
              {t.kind === "success" ? "✓" : "!"}
            </span>
            <div className="min-w-0">
              <p className="font-semibold leading-tight">{t.title}</p>
              {t.body ? <p className="mt-0.5 text-sm text-[var(--studio-muted)]">{t.body}</p> : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
