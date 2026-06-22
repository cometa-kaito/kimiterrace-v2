"use client";

import { useEffect, useState } from "react";
import { formatNewsDate } from "@/lib/signage/news-format";
import type { SignagePayload } from "@/lib/signage/signage-display";
import styles from "./signage.module.css";

/** 1 ニュースの表示時間（ms）。これ経過ごとに次の記事へ切り替える。 */
const NEWS_DWELL_MS = 6_000;

/**
 * パターン3（廊下版）フッタの**工学ニュース・カルーセル**（ADR-043）。フッタに常時置き、記事を**1 件ずつ
 * 自動で切り替える**（2026-06-22 ユーザー確定）。タイマーを持つので唯一の client island（盤面 `SignageBoardView`
 * 本体は hooks を持たず server 描画可能性を保つ＝この小コンポーネントだけ "use client"）。
 *
 * - 全記事を DOM に積み（絶対配置）、`active` のものだけ opacity:1 でクロスフェード表示する（非 active は
 *   `aria-hidden`）。全文が DOM に残るので region のテキスト照合（テスト）も安定。
 * - `prefers-reduced-motion` ではフェード遷移を止める（CSS 側ガード）。
 * - region は pattern2 と同じ `aria-label="時事ニュース"`（盤面 region ドリフトガード／SIGNAGE_BLOCK_META と整合）。
 * - **本文は転載しない**（見出し＋発表元＋公開日のみ。news_items 自体が本文を持たない・著作権方針）。記事無し /
 *   取得失敗（`null` / 空）は「ニュースを取得できていません」（fail-soft）。
 */
export function Pattern3NewsTicker({ news }: { news: SignagePayload["news"] }) {
  const items = news?.items ?? [];
  const [active, setActive] = useState(0);

  useEffect(() => {
    // 1 件以下は切り替え不要（タイマーを張らない＝静的）。
    if (items.length <= 1) {
      return;
    }
    const id = setInterval(() => {
      setActive((a) => (a + 1) % items.length);
    }, NEWS_DWELL_MS);
    return () => clearInterval(id);
  }, [items.length]);

  // 件数が減っても範囲外を指さないよう丸める（ポーリング更新対策）。
  const safe = items.length > 0 ? active % items.length : 0;

  return (
    <section aria-label="時事ニュース" className={styles.p3FootNews}>
      <span className={styles.p3FootNewsTag} aria-hidden="true">
        NEWS
      </span>
      {news?.isStale ? (
        <span className={styles.p3FootMuted} role="status">
          （情報が古い可能性）
        </span>
      ) : null}
      {items.length === 0 ? (
        <span className={styles.p3FootMuted}>ニュースを取得できていません</span>
      ) : (
        <div className={styles.p3FootNewsViewport}>
          {items.map((item, i) => (
            <div
              key={item.id}
              className={`${styles.p3FootNewsItem} ${i === safe ? styles.p3FootNewsItemActive : ""}`}
              aria-hidden={i === safe ? undefined : true}
            >
              <span className={styles.p3FootNewsTitle}>{item.title}</span>
              <span className={styles.p3FootNewsMeta}>
                {/* 出典明記（発表元ラベル）は ADR-043 で必須。公開日があれば併記する。 */}
                <span className={styles.p3FootNewsSource}>{item.sourceLabel}</span>
                {item.publishedAt ? (
                  <>
                    <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
                      ／
                    </span>
                    <span>{formatNewsDate(item.publishedAt)}</span>
                  </>
                ) : null}
              </span>
            </div>
          ))}
          {items.length > 1 ? (
            <span className={styles.p3FootNewsDots} aria-hidden="true">
              {items.map((item, i) => (
                <span
                  key={item.id}
                  className={`${styles.p3FootDot} ${i === safe ? styles.p3FootDotActive : ""}`}
                />
              ))}
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}
