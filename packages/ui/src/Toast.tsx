"use client";

import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { color, radius, space } from "./tokens";

/**
 * 通知のトーン。`error` はライブリージョンを `alert`（即時読み上げ）に、success/info は `status`
 * （丁寧読み上げ）にする。色は補助でテキストが意味の本体（NFR05）。
 */
export type ToastTone = "success" | "error" | "info";

export type ToastOptions = {
  tone?: ToastTone;
  /** 自動消滅までのミリ秒。0 以下で自動消滅しない（手動で閉じる）。既定 4000。 */
  durationMs?: number;
};

type ToastItem = { id: number; message: ReactNode; tone: ToastTone };

type ToastFn = (message: ReactNode, opts?: ToastOptions) => void;

const ToastContext = createContext<ToastFn | null>(null);

const DEFAULT_DURATION_MS = 4000;

const TONE: Record<ToastTone, { bg: string; fg: string; border: string }> = {
  success: { bg: color.successBg, fg: color.successFg, border: color.successBorder },
  error: { bg: color.dangerBg, fg: color.dangerFg, border: color.dangerBorder },
  info: { bg: color.infoBg, fg: color.infoFg, border: color.infoBorder },
};

/**
 * トースト通知のプロバイダ（**client**）。管理シェル（AppShell）の直下に 1 つ置き、配下の
 * client コンポーネントから `useToast()` で成功/エラー通知を出す。これまで「保存しました」等の
 * 成功フィードバックが無音だったり、エラーが reflow で消えたりしていたのを統一する。
 *
 * Server Component の children をそのまま透過するので、AppShell（server）から
 * `<ToastProvider>{children}</ToastProvider>` で包める。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (message, opts) => {
      idRef.current += 1;
      const id = idRef.current;
      const tone = opts?.tone ?? "info";
      setToasts((prev) => [...prev, { id, message, tone }]);
      const duration = opts?.durationMs ?? DEFAULT_DURATION_MS;
      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: space.lg,
          right: space.lg,
          display: "flex",
          flexDirection: "column",
          gap: space.sm,
          zIndex: 1100,
          maxWidth: "min(92vw, 24rem)",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * トーストを出す関数を返す。`<ToastProvider>` の外で呼ぶと throw（配線漏れを早期検知）。
 *
 * @example
 * const toast = useToast();
 * toast("保存しました", { tone: "success" });
 */
export function useToast(): ToastFn {
  const toast = useContext(ToastContext);
  if (!toast) {
    throw new Error("useToast は <ToastProvider> の内側で使ってください。");
  }
  return toast;
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const t = TONE[item.tone];
  return (
    <div
      // error は即時、それ以外は丁寧に読み上げる。
      role={item.tone === "error" ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
        padding: `${space.sm} ${space.md}`,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.border}`,
        borderRadius: radius.md,
        boxShadow: "0 8px 24px rgba(17, 24, 39, 0.12)",
        fontSize: "0.9rem",
        lineHeight: 1.5,
        pointerEvents: "auto",
      }}
    >
      <span style={{ flex: 1 }}>{item.message}</span>
      <button
        type="button"
        aria-label="閉じる"
        onClick={onDismiss}
        style={{
          flexShrink: 0,
          border: "none",
          background: "transparent",
          color: t.fg,
          cursor: "pointer",
          fontSize: "1rem",
          lineHeight: 1,
          padding: 0,
        }}
      >
        ✕
      </button>
    </div>
  );
}
