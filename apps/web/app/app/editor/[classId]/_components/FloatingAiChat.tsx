"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import styles from "./FloatingAiChat.module.css";

/** リサイズの下限（px）。ヘッダ＋入力欄が潰れない最小。 */
const MIN_W = 300;
const MIN_H = 360;
/** キーボード矢印 1 回あたりの増減（px）。 */
const KEY_STEP = 32;
/** リサイズ後のサイズを次回起動へ引き継ぐ localStorage キー。 */
const SIZE_STORAGE_KEY = "kt:floating-ai-chat:size";
/** 矢印キー → [幅Δ, 高さΔ]（px）。向きはドラッグと一致（左/上で拡大）。再生成しないよう module スコープに置く。 */
const RESIZE_KEY_DELTAS: Record<string, [number, number]> = {
  ArrowLeft: [KEY_STEP, 0], // 左 = 幅を広げる
  ArrowRight: [-KEY_STEP, 0], // 右 = 幅を狭める
  ArrowUp: [0, KEY_STEP], // 上 = 高さを伸ばす
  ArrowDown: [0, -KEY_STEP], // 下 = 高さを縮める
};

/**
 * パネルは右下固定なので、ビューポートに収まる最大幅/高さへクランプする
 * （max ≈ 100vw/100dvh − 2.5rem(=40px) で CSS の max-* と整合）。下限は {@link MIN_W}/{@link MIN_H}。
 */
function clampSize(width: number, height: number): { width: number; height: number } {
  const maxW = Math.max(MIN_W, window.innerWidth - 40);
  const maxH = Math.max(MIN_H, window.innerHeight - 40);
  return {
    width: Math.round(Math.min(Math.max(width, MIN_W), maxW)),
    height: Math.round(Math.min(Math.max(height, MIN_H), maxH)),
  };
}

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
  // ドラッグ中フラグ。マルチタッチ等の二重 pointerdown で listener を多重登録しないための再入ガード。
  const resizingRef = useRef(false);
  // null = CSS 既定サイズ。ドラッグ/矢印キーで上書きしたときだけ {width,height} を持つ。
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // モバイル幅（≤640px）はボトムシート固定。inline サイズを当てず CSS に委ねる（リサイズも無効）。
  const [isCompact, setIsCompact] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // ビューポート幅を監視し compact 判定を CSS の media query と一致させる。
  // 初期描画は false（= SSR と一致）、マウント後に実値へ。jsdom 等 matchMedia 非対応環境は false のまま。
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setIsCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 前回ユーザーが決めたサイズを復元（壊れた値 / localStorage 不可は既定サイズで黙って続行）。
  // SSR とのハイドレーション不一致を避けるため初期描画は既定のまま、マウント後に適用する。
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SIZE_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof (parsed as { width?: unknown }).width === "number" &&
        typeof (parsed as { height?: unknown }).height === "number"
      ) {
        const p = parsed as { width: number; height: number };
        setSize(clampSize(p.width, p.height));
      }
    } catch {
      // 無視（既定サイズで続行）。
    }
  }, []);

  const persistSize = useCallback((next: { width: number; height: number }) => {
    try {
      window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可でも実行時サイズ（state）は効くので黙って続行。
    }
  }, []);

  // ハンドルのダブルクリック / Home キーで既定サイズへ戻す。
  const onResetSize = useCallback(() => {
    setSize(null);
    try {
      window.localStorage.removeItem(SIZE_STORAGE_KEY);
    } catch {
      // 無視。
    }
  }, []);

  // 左上角ハンドルのドラッグでリサイズ。パネルは右下固定なので「左/上へ動かすほど大きく」なる。
  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || resizingRef.current) {
        return;
      }
      e.preventDefault();
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      resizingRef.current = true;
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = rect.width;
      const startH = rect.height;
      const handle = e.currentTarget;
      handle.setPointerCapture?.(e.pointerId);
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none"; // ドラッグ中の不要なテキスト選択を抑止。

      let latest = { width: startW, height: startH };
      const onMove = (ev: PointerEvent) => {
        latest = clampSize(startW + (startX - ev.clientX), startH + (startY - ev.clientY));
        setSize(latest);
      };
      const onUp = () => {
        handle.releasePointerCapture?.(e.pointerId);
        document.body.style.userSelect = prevUserSelect;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        resizingRef.current = false;
        persistSize(latest);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [persistSize],
  );

  // キーボードでもリサイズ（ハンドルは focusable）。矢印の向き = ドラッグの向きに合わせる。
  // Home で既定サイズに戻す（マウス無し利用者も復帰できるよう onDoubleClick と対にする）。
  const onResizeKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Home") {
        e.preventDefault();
        onResetSize();
        return;
      }
      const delta = RESIZE_KEY_DELTAS[e.key];
      if (!delta) {
        return;
      }
      e.preventDefault();
      const rect = panelRef.current?.getBoundingClientRect();
      const baseW = size?.width ?? rect?.width ?? MIN_W;
      const baseH = size?.height ?? rect?.height ?? MIN_H;
      const next = clampSize(baseW + delta[0], baseH + delta[1]);
      setSize(next);
      persistSize(next);
    },
    [size, persistSize, onResetSize],
  );

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

  // 閉じている間は display:none。リサイズ済み かつ 非 compact のときだけ width/height を上書きする
  // （compact＝モバイル幅では CSS のボトムシート指定に委ね、inline サイズを当てない）。
  const panelStyle: CSSProperties = {
    ...(open ? null : { display: "none" }),
    ...(size && !isCompact ? { width: size.width, height: size.height } : null),
  };

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
        style={panelStyle}
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
        {/*
         * 左上角のリサイズハンドル（右下固定パネルなので空く角はここ）。DOM 上は最後に置き、
         * 開いた瞬間のフォーカス対象（× ボタン）を奪わせない。モバイル（ボトムシート）は CSS で隠す。
         */}
        <button
          type="button"
          className={styles.resizeHandle}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
          onDoubleClick={onResetSize}
          aria-label="AI チャットの大きさを変える（ドラッグまたは矢印キー、ダブルクリックまたは Home キーで既定に戻す）"
          title="ドラッグで大きさを変える（ダブルクリックまたは Home キーで既定に戻す）"
        >
          <span aria-hidden="true" className={styles.resizeGrip} />
        </button>
      </div>
    </>
  );
}
