"use client";

import type { MergedSection } from "@/lib/signage/effective-daily-data";
import {
  clampAdDurationMs,
  clampIndex,
  jitteredPollMs,
  jstDateString,
  nextIndex,
} from "@/lib/signage/rotation";
import type { SignagePayload } from "@/lib/signage/signage-display";
import { useCallback, useEffect, useRef, useState } from "react";
import { SignageInvalid } from "./SignageInvalid";

/**
 * サイネージ再生制御 Client Island (#48-E2 / F12)。#48-E1 の静的描画に対し、本コンポーネントが
 * (a) 広告を 1 件ずつ duration 秒で巡回し、(b) 5-10 秒ポーリングで最新データへ自動更新する。
 * V1 Firestore `onSnapshot` の置換 (ADR-022 pull 型)。データ取得は data Route Handler 経由
 * (サーバーで token→RLS 解決)。本クライアントに DB アクセスは持ち込まない。
 */
export function SignageClient({
  classToken,
  initial,
}: {
  classToken: string;
  initial: SignagePayload;
}) {
  const [data, setData] = useState<SignagePayload>(initial);
  const [invalid, setInvalid] = useState(false);
  const [adIndex, setAdIndex] = useState(0);

  const ads = data.ads;
  const adCount = ads.length;

  // --- 自動更新ポーリング (jitter 付き再帰 setTimeout、tab 非表示時はスキップして接続節約) ---
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) {
      return; // 非表示中は叩かない (Cloud SQL 接続節約)。次サイクルで再開。
    }
    try {
      const res = await fetch(
        `/signage/${encodeURIComponent(classToken)}/data?date=${jstDateString()}`,
        { cache: "no-store" },
      );
      if (res.status === 410) {
        setInvalid(true);
        return;
      }
      if (res.ok) {
        setData((await res.json()) as SignagePayload);
      }
      // それ以外 (5xx 等) は前回データを保持し次サイクルで再試行 (一時的なネット断に強く)。
    } catch {
      // ネットワークエラーは握りつぶし、最後に成功した表示を維持する。
    }
  }, [classToken]);

  useEffect(() => {
    if (invalid) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const loop = () => {
      timer = setTimeout(async () => {
        await poll();
        if (!cancelled) {
          loop();
        }
      }, jitteredPollMs());
    };
    loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll, invalid]);

  // --- 広告ローテーション (現在広告の duration で次へ。件数変動時は index を丸める) ---
  const safeIndex = clampIndex(adIndex, adCount);
  // 最新の広告配列を ref に保持する。ローテーション effect の依存に `ads` 参照を入れると、
  // ポーリング (8-12s) のたびに新しい配列参照でタイマーがリセットされ、ポーリング間隔より長い
  // 広告 (clamp 上限 120s) が巡回しなくなる。依存は safeIndex/adCount だけにし、duration は ref
  // から読むことで「内容が同じポーリングでは再生位相を保つ」「index 前進・件数変動でのみ再スケジュール」。
  const adsRef = useRef(ads);
  adsRef.current = ads;
  useEffect(() => {
    if (adCount <= 1) {
      return; // 0/1 件は巡回不要。
    }
    const ms = clampAdDurationMs(adsRef.current[safeIndex]?.durationSec ?? 0);
    const id = setTimeout(() => setAdIndex((i) => nextIndex(i, adCount)), ms);
    return () => clearTimeout(id);
  }, [safeIndex, adCount]);

  if (invalid) {
    return <SignageInvalid />;
  }

  const ad = adCount > 0 ? ads[safeIndex] : null;

  return (
    <div style={rootStyle}>
      <main style={contentStyle}>
        <header style={dateHeaderStyle}>{data.date}</header>
        <div style={gridStyle}>
          <Section title="時間割" section={data.daily.schedules} />
          <Section title="連絡" section={data.daily.notices} />
          <Section title="課題" section={data.daily.assignments} />
          <Section title="静粛時間" section={data.daily.quietHours} />
        </div>
      </main>

      <aside aria-label="広告" style={adPaneStyle}>
        {ad ? (
          <figure style={adFigureStyle} key={ad.adId}>
            {ad.mediaType === "video" ? (
              <video src={ad.mediaUrl} autoPlay muted loop playsInline style={adMediaStyle} />
            ) : (
              // 外部 CDN URL の広告画像。Next/Image の最適化対象外のため素の img を使う。
              <img src={ad.mediaUrl} alt={ad.caption ?? ""} style={adMediaStyle} />
            )}
            {ad.caption ? (
              <figcaption style={{ ...adCaptionStyle, fontSize: `${ad.captionFontScale}rem` }}>
                {ad.caption}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <p style={adEmptyStyle}>　</p>
        )}
        {adCount > 1 ? <span style={adDotsStyle}>{dots(adCount, safeIndex)}</span> : null}
      </aside>
    </div>
  );
}

function Section({ title, section }: { title: string; section: MergedSection }) {
  return (
    <section aria-label={title} style={sectionStyle}>
      <h2 style={sectionTitleStyle}>
        {title}
        {section.source && section.source !== "class" ? (
          <span style={badgeStyle}>{section.source === "school" ? "学校共通" : "学年共通"}</span>
        ) : null}
      </h2>
      {section.items.length === 0 ? (
        <p style={emptyStyle}>なし</p>
      ) : (
        <ol style={itemsStyle}>
          {section.items.map((item, i) => (
            // 順序が意味を持ち再並びしない静的リストなので index key で十分。
            // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
            <li key={i} style={itemStyle}>
              {itemLabel(item)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * opaque な JSONB 要素から代表ラベルを防御的に取り出す (#48-E1 SignageBoard と同方針・同キー順で
 * 描画一貫性を保つ。Notice=`text` / Assignment=`subject` がヒットする)。
 */
function itemLabel(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item === "object") {
    const rec = item as Record<string, unknown>;
    for (const key of ["title", "label", "text", "subject", "name", "content"]) {
      const v = rec[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  return JSON.stringify(item);
}

/** ローテーション位置のドット表示 (現在位置を ● 他を ○)。 */
function dots(count: number, active: number): string {
  return Array.from({ length: count }, (_, i) => (i === active ? "●" : "○")).join(" ");
}

const rootStyle: React.CSSProperties = {
  height: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
  gap: "1.5rem",
  padding: "1.5rem",
  boxSizing: "border-box",
};
const contentStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  minWidth: 0,
};
const dateHeaderStyle: React.CSSProperties = {
  fontSize: "2rem",
  fontWeight: 700,
  borderBottom: "2px solid #334155",
  paddingBottom: "0.5rem",
};
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "1rem",
  overflow: "hidden",
};
const sectionStyle: React.CSSProperties = {
  border: "1px solid #334155",
  borderRadius: "10px",
  padding: "0.75rem 1rem",
  background: "rgba(255,255,255,0.03)",
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1.2rem",
  margin: "0 0 0.5rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};
const itemsStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.25rem",
  display: "grid",
  gap: "0.3rem",
};
const itemStyle: React.CSSProperties = { fontSize: "1.1rem" };
const emptyStyle: React.CSSProperties = { color: "#64748b", margin: 0, fontSize: "1rem" };
const adPaneStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  minWidth: 0,
};
const adFigureStyle: React.CSSProperties = {
  margin: 0,
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
};
const adMediaStyle: React.CSSProperties = {
  maxWidth: "100%",
  maxHeight: "80%",
  objectFit: "contain",
  borderRadius: "10px",
};
const adCaptionStyle: React.CSSProperties = { margin: 0, textAlign: "center", color: "#e2e8f0" };
const adEmptyStyle: React.CSSProperties = { color: "#475569" };
const adDotsStyle: React.CSSProperties = { letterSpacing: "0.25rem", color: "#94a3b8" };
const badgeStyle: React.CSSProperties = {
  fontSize: "0.75rem",
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  background: "#334155",
  color: "#e2e8f0",
};
