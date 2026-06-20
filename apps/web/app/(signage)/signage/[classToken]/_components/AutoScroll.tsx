"use client";

import { useEffect, useRef } from "react";
import styles from "./AutoScroll.module.css";

/**
 * サイネージ盤面の **縦オートスクロール**（自動的に動いていく機構・2026-06-20 ユーザー要望）。コンテンツが枠に
 * 収まらない時に、中身を**全件 DOM に保持したまま**ゆっくり上下にスクロールして全体を順に見せる。時事ニュース
 * （要約付き・複数記事）や連絡（長文）の「入れた文字が枠で切れて一部見えなくなる」を解消する。
 *
 * ## 動き（ping-pong・コンテンツ複製なし）
 * 上端で一拍 → 下端まで等速スクロール → 下端で一拍 → 上端へ戻る、を無限ループ。**中身を複製しない**ので DOM に
 * 重複が出ず（テストの `getAllByRole` / 出典明記が一意に保たれる）、アクセシビリティ・既存スナップショットを壊さない。
 *
 * ## fail-soft / 環境安全（重要）
 * - **収まる時は動かさない**: `track.scrollHeight - viewport.clientHeight <= 閾値` ならアニメーション無し＝静的（枠内に
 *   素直に表示）。回帰ゼロ。
 * - **jsdom / SSR / サムネ**: レイアウト計測が 0（jsdom）や effect 未実行（SSR）の環境では距離 0 と判定し静的描画。
 *   **子要素は常に DOM に出す**ので `toHaveTextContent` 系テストは緑のまま（[[ref_apps_web_tsx_tests_need_full_suite]]）。
 * - **ブラウザ専用 API は存在ガード**: `Element.animate` / `ResizeObserver` / `matchMedia` が無い環境でも例外を投げず
 *   静的にフォールバックする（古い WebView 安全）。
 * - **reduced-motion 尊重**: `prefers-reduced-motion: reduce` の時はアニメーションせず静的（NFR・酔い配慮）。
 *
 * @param play  `false` で常に静的（編集モード等で動きを止めたい時）。既定 `true`。
 */
export function AutoScroll({
  children,
  className,
  play = true,
}: {
  children: React.ReactNode;
  className?: string;
  play?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || !play) {
      return;
    }
    // ブラウザ専用 API の存在ガード（jsdom / 古い WebView では未実装 → 静的フォールバック）。
    if (typeof track.animate !== "function") {
      return;
    }
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    let animation: Animation | null = null;

    /** 現在のはみ出し量を測り、必要ならスクロールアニメーションを張り直す（収まるなら静的）。 */
    const apply = () => {
      animation?.cancel();
      animation = null;
      const distance = track.scrollHeight - viewport.clientHeight;
      if (distance <= 4) {
        // 収まっている（または計測不能=0）→ 動かさない。トラックは原点のまま。
        return;
      }
      const speedPxPerSec = 24; // 遠目でも読める控えめな速度。
      const travelMs = (distance / speedPxPerSec) * 1000;
      const pauseMs = 2600; // 上端・下端で読むための停止。
      const total = pauseMs + travelMs + pauseMs + travelMs;
      animation = track.animate(
        [
          { transform: "translateY(0)", offset: 0 },
          { transform: "translateY(0)", offset: pauseMs / total },
          { transform: `translateY(-${distance}px)`, offset: (pauseMs + travelMs) / total },
          {
            transform: `translateY(-${distance}px)`,
            offset: (pauseMs + travelMs + pauseMs) / total,
          },
          { transform: "translateY(0)", offset: 1 },
        ],
        { duration: total, iterations: Number.POSITIVE_INFINITY, easing: "linear" },
      );
    };

    apply();

    // コンテンツ/枠の寸法変化（ポーリング更新・フォント読込・回転）で測り直す。
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => apply());
      observer.observe(viewport);
      observer.observe(track);
    }

    return () => {
      animation?.cancel();
      observer?.disconnect();
    };
  }, [play]);

  return (
    <div ref={viewportRef} className={`${styles.viewport} ${className ?? ""}`}>
      <div ref={trackRef} className={styles.track}>
        {children}
      </div>
    </div>
  );
}
