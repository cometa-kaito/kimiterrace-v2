"use client";

import { Children, useEffect, useState } from "react";
import styles from "./signage.module.css";

/** 1 記事を見せる時間（この間隔で次の記事へ横スライド）。見出し＋要約2文を遠目で読み切れる長さに設定
 * （2026-06-21 ユーザー: 6 秒では短く読み切れない → 12 秒へ）。 */
const ADVANCE_MS = 12000;

/**
 * サイネージ pattern4 の **時事ニュース カルーセル**（2026-06-20 ユーザー指示）。**常に 1 記事だけ縦に収め**、
 * 一定間隔で次の記事が**横から「しゅん」とスライドして記事全体を差し替える**。複数記事を 1 枠に詰めて文字が
 * 切れるのを避け、1 記事ずつ大きく読ませる（要約は呼び出し側で先頭文だけ抽出済み・AI 不使用）。
 *
 * ## 設計上の不変条件
 * - **全記事を DOM に保持**: スライドは `transform: translateX` で見せ／隠しするだけで、子要素（見出し・要約 li・
 *   出典明記）は**常に DOM に残る**。アクセシビリティ（region/出典）と `toHaveTextContent`/`getAllByRole` 系
 *   テストが緑のまま（[[ref_apps_web_tsx_tests_need_full_suite]]）。スライドは複製しない。
 * - **環境安全 / fail-soft**: 記事 1 件以下なら自動送りしない（静止）。`matchMedia` が無い／`prefers-reduced-motion`
 *   の環境では自動送りせず先頭記事を静止表示。jsdom/SSR は effect 未実行または timer 未進行で index=0 の静止
 *   （ハイドレーション不一致なし）。
 * - **子の描画は呼び出し側**: 本コンポーネントは「横スライドで 1 件ずつ送る」汎用機構のみ。記事の中身
 *   （`NewsItemBody`）は SignageBoardView 側が組み、配列で `children` に渡す（RSC 境界を越えるのは要素のみ・
 *   関数は渡さない）。
 */
export function NewsCarousel({ children }: { children: React.ReactNode }) {
  const slides = Children.toArray(children);
  const count = slides.length;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (count <= 1) {
      return;
    }
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % count);
    }, ADVANCE_MS);
    return () => clearInterval(timer);
  }, [count]);

  // 記事更新（ポーリング）で件数が減っても範囲内に丸める（範囲外スライドを指さない）。
  const active = count > 0 ? index % count : 0;

  return (
    <div className={styles.newsCarousel}>
      <div className={styles.newsCarouselViewport}>
        <div
          className={styles.newsCarouselTrack}
          style={{ transform: `translateX(-${active * 100}%)` }}
        >
          {slides.map((slide, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: スライドは記事数ぶんの固定リスト
            <div key={i} className={styles.newsCarouselSlide}>
              {slide}
            </div>
          ))}
        </div>
      </div>
      {count > 1 ? (
        <div className={styles.newsCarouselDots} aria-hidden="true">
          {slides.map((_, i) => {
            const dotClass = `${styles.newsCarouselDot} ${i === active ? styles.newsCarouselDotActive : ""}`;
            // biome-ignore lint/suspicious/noArrayIndexKey: ドットは記事数ぶんの固定リスト
            return <span key={i} className={dotClass} />;
          })}
        </div>
      ) : null}
    </div>
  );
}
