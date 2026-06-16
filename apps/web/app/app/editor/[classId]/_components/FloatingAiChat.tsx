"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./FloatingAiChat.module.css";

/**
 * 右下に浮く **AI 支援チャット**（FAB + パネル）の汎用ラッパ。
 *
 * 編集画面（盤面エディタ）を本画面に保ったまま、AI 会話（{@link "../../_components/EditorChat"}）を
 * 「呼び出して使う支援」へ格下げする UI（ユーザー判断 2026-06-16: タブ shell を廃し AI は浮遊チャット）。
 * - **FAB**: `position: fixed` の右下ボタン。クリックでパネルを開閉する（`aria-expanded` / `aria-controls`）。
 * - **パネル**: デスクトップは右下に浮くカード、モバイル(≤640px)はボトムシート（CSS module の media query）。
 *   閉じるボタン（×）と Esc で閉じ、開いた瞬間にパネル内へフォーカスを移す（a11y）。背面（盤面）は
 *   スクロール可のまま＝重い modal にしない（背景オーバーレイで全操作をブロックしない）。
 * - `children` をそのままパネルに描画する（= 呼び出し側が `EditorChat` を渡す）。本体は開閉と a11y だけを担い、
 *   会話・保存・SSE の挙動には一切関与しない（挙動温存）。
 *
 * **非破壊**: 閉じている間も `children` はマウントしたまま（display で出し分け）。途中の会話・下書きを失わない。
 */
export function FloatingAiChat({
  label = "AIで作る",
  title = "AI で作る",
  children,
}: {
  /** FAB のラベル（既定「AIで作る」）。 */
  label?: string;
  /** パネル上部の見出し（既定「AI で作る」）。FAB ラベルと別文言にして既存ロケータと二重化しない。 */
  title?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // 開いたらパネル内の最初の操作対象（閉じるボタン）へフォーカスを移す（キーボード/SR 利用者が迷子にならない）。
  useEffect(() => {
    if (!open) {
      return;
    }
    const el = panelRef.current?.querySelector<HTMLElement>(
      "button, textarea, input, [href], select, [tabindex]:not([tabindex='-1'])",
    );
    el?.focus();
  }, [open]);

  // Esc で閉じる（開いている間だけ listener を張る）。閉じたら FAB へフォーカスを戻す。
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        fabRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* FAB: パネルが開いているときは隠す（閉じる導線は × に一本化・二重操作子を作らない）。 */}
      {open ? null : (
        <button
          ref={fabRef}
          type="button"
          className={styles.fab}
          aria-expanded={false}
          aria-controls={panelId}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true" className={styles.fabIcon}>
            💬
          </span>
          {label}
        </button>
      )}

      {/* パネルは閉じている間もマウントしたまま children を保持し、display で出し分ける（会話・下書きを失わない）。 */}
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label={title}
        aria-modal={false}
        className={styles.panel}
        style={open ? undefined : { display: "none" }}
      >
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>
            <span aria-hidden="true" className={styles.fabIcon}>
              💬
            </span>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            onClick={() => {
              close();
              fabRef.current?.focus();
            }}
            aria-label="AI チャットを閉じる"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className={styles.panelBody}>{children}</div>
      </div>
    </>
  );
}
