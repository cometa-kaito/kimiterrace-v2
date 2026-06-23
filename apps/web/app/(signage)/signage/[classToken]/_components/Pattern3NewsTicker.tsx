"use client";

import { useEffect, useState } from "react";
import { formatNewsDate } from "@/lib/signage/news-format";
import type { SignagePayload } from "@/lib/signage/signage-display";
import styles from "./signage.module.css";

/** 1 ニュースの表示時間（ms）。これ経過ごとに次の記事へ切り替える（2026-06-22 ユーザー指定 15 秒）。 */
const NEWS_DWELL_MS = 15_000;

/** フッタのニュースに出す本文（公式要約）の最大文数。先頭 N 文をコンパクトに添える（2026-06-23 ユーザー指示で
 *  カード高を下げるため 1 文＝箇条書き 1 個に絞る）。 */
const FOOTER_SUMMARY_SENTENCES = 1;

/**
 * 公式要約（CC BY ソースのみ非 null）を「。」で文分割し、先頭 {@link FOOTER_SUMMARY_SENTENCES} 文を返す
 * （各文末に「。」を付け直す）。SignageBoardView の `splitNewsSummary`（pattern4 用・最大4文）の廊下フッタ版
 * （カード高を抑えるため 1 文＝箇条書き 1 個に絞る）。空要素は捨てる。
 */
function footerSummary(summary: string): string[] {
  return summary
    .split("。")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, FOOTER_SUMMARY_SENTENCES)
    .map((s) => `${s}。`);
}

/**
 * パターン3（廊下版）フッタの**時事ニュース・カード**（ADR-043）。フッタに**枠ありのカード**で常時置き、記事を
 * **1 件ずつ自動で切り替える**（2026-06-22 ユーザー確定）。**見出し＋本文（公式要約・先頭2文）**を出す（要約は
 * pattern4 と同じ CC BY ソース＝経産省 METI のみ非 null。それ以外は見出しのみ）。タイマーを持つので唯一の client
 * island（盤面 `SignageBoardView` 本体は hooks を持たず server 描画可能性を保つ＝この小コンポーネントだけ "use client"）。
 *
 * - 全記事を DOM に積み（絶対配置）、`active` のものだけ opacity:1 でクロスフェード表示する（非 active は
 *   `aria-hidden`）。全文が DOM に残るので region のテキスト照合（テスト）も安定。
 * - `prefers-reduced-motion` ではフェード遷移を止める（CSS 側ガード）。
 * - region は pattern2/4 と同じ `aria-label="時事ニュース"`（盤面 region ドリフトガード／SIGNAGE_BLOCK_META と整合）。
 * - **本文（要約）は CC BY 配信の公式要約のみ**（転載でなく合法 gate は取得 Job 済）。出典は発表元ラベルが担う。記事
 *   無し / 取得失敗（`null` / 空）は「ニュースを取得できていません」（fail-soft）。
 */
export function Pattern3NewsTicker({ news }: { news: SignagePayload["news"] }) {
  // **本文（公式要約）がある記事だけ**を出す（2026-06-22 ユーザー指定）。要約は CC BY ソース（経産省 METI）のみ
  // 非 null なので、実質 CC BY 記事のみが廊下フッタに回る（見出しのみの記事は出さない）。
  const items = (news?.items ?? []).filter(
    (item): item is typeof item & { summary: string } =>
      typeof item.summary === "string" && item.summary.trim().length > 0,
  );
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
    <section aria-label="時事ニュース" className={styles.p3NewsCard}>
      <h2 className={styles.p3NewsTitle}>
        時事ニュース
        {news?.isStale ? (
          <span className={styles.p3FootMuted} role="status">
            （情報が古い可能性）
          </span>
        ) : null}
      </h2>
      {items.length === 0 ? (
        <p className={styles.p3FootMuted}>ニュースを取得できていません</p>
      ) : (
        <div className={styles.p3NewsViewport}>
          {items.map((item, i) => {
            const summary = footerSummary(item.summary);
            return (
              <article
                key={item.id}
                className={`${styles.p3NewsSlide} ${i === safe ? styles.p3NewsSlideActive : ""}`}
                aria-hidden={i === safe ? undefined : true}
              >
                <span className={styles.p3NewsHeadline}>{item.title}</span>
                {summary.length > 0 ? (
                  <ul className={styles.p2NewsSummary}>
                    {summary.map((s, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 不変リスト（1 記事内の文分割）の描画
                      <li key={j}>{s}</li>
                    ))}
                  </ul>
                ) : null}
                <span className={styles.p3NewsMeta}>
                  {/* 出典明記（発表元ラベル）は ADR-043 で必須。公開日があれば併記する。 */}
                  <span className={styles.p3NewsSource}>{item.sourceLabel}</span>
                  {item.publishedAt ? (
                    <>
                      <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
                        ／
                      </span>
                      <span>{formatNewsDate(item.publishedAt)}</span>
                    </>
                  ) : null}
                </span>
              </article>
            );
          })}
          {items.length > 1 ? (
            <span className={styles.p3NewsDots} aria-hidden="true">
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
