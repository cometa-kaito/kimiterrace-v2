"use client";

import { useEffect, useState } from "react";
import styles from "./signage.module.css";

/**
 * 盤面ブロックの**自動ページング client island**（F1 / editor-input-tiers-and-signage-paging.md・§10b）。
 * 規定行数（`blockRowCapacity`）を超えた編集ブロック（予定 1 列 / 連絡 / 提出物 / 呼び出し / 来校者）で、
 * 溢れた行を連続スクロールで流す代わりに**複数ページへ分割し、一定滞留（`SIGNAGE_PAGE_DWELL_MS`）ごとに
 * フェードで循環表示**する。オーナー確定（2026-07-02）＝連続マーキーではなくページング（廊下距離の可読性・
 * 滞留 5–10 秒。設計書 §0-1 / §3 F1）。
 *
 * ## `SignageBoardView` の server 描画可能性を壊さない
 * 盤面レンダラ本体（`SignageBoardView`）は hooks を持たないまま（実機と `ScaledSignageBoard` の単一ソース）。
 * タイマー / ページ index の state は**この小さな client island に閉じ込める**（`AutoScroll` / `NewsCarousel` と
 * 同じ作法）。呼び出し側（server 描画可能）は各ページの**確定済みマークアップ**を `pages`（ReactNode[]）として
 * 渡すだけ＝レイアウト固有の track（grid / ul / table）は呼び出し側に残る。
 *
 * ## 挙動
 * - **全ページを DOM に積む**（絶対配置でスタック）。active のページだけ `opacity:1`、他は `opacity:0` +
 *   `aria-hidden`。全行が DOM に残るのでテキスト照合（テスト）・切り捨てゼロ（受け入れ基準2）を満たす。
 * - ページが 2 つ以上ある時だけタイマーを張り、`dwellMs` ごとに次ページへ循環する。1 ページ以下では呼び出し側が
 *   本コンポーネントを使わず現行どおり静的描画する運用（発動条件＝溢れた時のみ・収まれば完全に静止）。
 * - アニメは opacity のみ（合成レイヤーで完結・低スペック Google TV WebView 対策）。`prefers-reduced-motion`
 *   ではフェード遷移を CSS 側で止める（ページ切替自体は続け、全行を必ず読めるようにする）。
 * - ページが複数ある時だけ右下に小さなページインジケータ（●○○）を出す。
 * - SSR / jsdom では effect が走るまで先頭ページを静的表示（全ページ DOM 保持なのでテキストは全件見える）。
 */
export function BoardPager({
  pages,
  dwellMs,
  play = true,
  viewportClassName,
}: {
  pages: React.ReactNode[];
  dwellMs: number;
  /** `false` で切替を止め先頭ページを静的表示（編集モード等・`AutoScroll` の `play` と同作法）。既定 `true`。 */
  play?: boolean;
  /** ビューポート（`position:relative` のページスタック）に足す追加クラス（ブロック別のサイズ調整用）。 */
  viewportClassName?: string;
}) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    // 1 ページ以下・停止指定は切替不要（タイマーを張らない＝静的）。件数減の丸めは下の safe が担う。
    if (!play || pages.length <= 1) {
      return;
    }
    const id = setInterval(() => {
      setActive((a) => (a + 1) % pages.length);
    }, dwellMs);
    return () => clearInterval(id);
  }, [play, pages.length, dwellMs]);

  // ポーリング更新でページ数が減っても範囲外を指さないよう丸める（play=false 時も先頭へ倒す）。
  const safe = play && pages.length > 0 ? active % pages.length : 0;

  return (
    <div className={`${styles.pagerViewport} ${viewportClassName ?? ""}`}>
      {pages.map((page, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: ページは順序固定の分割スライス（並び替えない）
          key={i}
          className={`${styles.pagerPage} ${i === safe ? styles.pagerPageActive : ""}`}
          aria-hidden={i === safe ? undefined : true}
        >
          {page}
        </div>
      ))}
      {pages.length > 1 ? (
        <span className={styles.pagerDots} aria-hidden="true">
          {pages.map((_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 固定長の装飾ドット列
              key={i}
              className={`${styles.pagerDot} ${i === safe ? styles.pagerDotActive : ""}`}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
