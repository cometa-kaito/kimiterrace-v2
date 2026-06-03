"use client";

import type { MergedSection } from "@/lib/signage/effective-daily-data";
import { getClientId, sendSignageEvent } from "@/lib/signage/event-beacon";
import {
  cleanupStaleMedia,
  prefetchMedia,
  registerSignageServiceWorker,
  selectPrefetchUrls,
} from "@/lib/signage/media-cache";
import {
  VIEW_HEARTBEAT_MS,
  clampAdDurationMs,
  clampIndex,
  jitteredPollMs,
  jstDateString,
  nextIndex,
} from "@/lib/signage/rotation";
import { type SignageSectionKind, formatSignageItem } from "@/lib/signage/section-format";
import type { SignagePayload } from "@/lib/signage/signage-display";
import type { SignageWeather, WeatherDay, WeatherIcon } from "@/lib/signage/weather";
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

  // --- 広告 impression テレメトリ (#43 / F07) + 分粒度ハートビート (#322 / ADR-025)。表示中の広告に
  //     ついて view をベストエフォート送信する (広告主の到達数集計 = F07 ユーザーストーリーの基礎データ)。
  //     (1) 表示中の広告が変わった瞬間に 1 件、(2) 同じ広告を表示し続ける間は `VIEW_HEARTBEAT_MS` ごとに
  //     再送する。到達数 (reach) は集計時に (client_id, ad_id, JST 分) で重複排除される (getAdReach /
  //     ADR-025) ため、分粒度ハートビートにより「ローテーションせずマウント中 1 回しか送らなかった単一
  //     広告クラス」の到達過少計上が解消し、複数広告クラス (ローテーションで自然に再送) と枚数に依らず
  //     公平になる。同一分内の重複は dedup で 1 に集約されるため水増しはしない (延べ表示数のみ増、許容)。
  //     依存は現在広告の adId と slotIndex のみ — 内容不変なポーリング (8-12s ごとに新しい配列参照) では
  //     再スケジュールせず、ローテーション前進・データ更新で「表示中の広告が実際に変わった」時だけ送信を
  //     張り替える (rotation/prefetch effect と同じ「内容が同じなら据え置き」規律)。tab 非表示中は送らない
  //     (実際に表示されていない時間を到達に数えない + テレメトリ節約、poll と同方針)。送信失敗は表示を
  //     ブロックしない (event-beacon が握りつぶす)。 ---
  const currentAdId = adCount > 0 ? (ads[safeIndex]?.adId ?? null) : null;
  useEffect(() => {
    if (!currentAdId) {
      return;
    }
    const sendView = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return; // 非表示中は到達に数えない (次の周期で再開、最後の表示状態は維持)。
      }
      const clientId = getClientId();
      sendSignageEvent(classToken, {
        type: "view",
        adId: currentAdId,
        slotIndex: safeIndex,
        ...(clientId ? { clientId } : {}),
      });
    };
    sendView(); // (1) 表示開始時に即送信。
    // (2) 表示継続中は分粒度で再送し、到達 minute を取りこぼさない (単一/複数広告の公平化)。
    const id = setInterval(sendView, VIEW_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [currentAdId, safeIndex, classToken]);

  // --- 広告タップ (click-through) テレメトリ (#43 / F07 第3スライス)。インタラクティブ端末で生徒が
  //     linkUrl 付き広告をタップした時に `tap` を 1 件送る (view と別種、広告主のクリック到達計測)。
  //     view (表示) と違いユーザー起点なので effect でなくハンドラで都度送る。遷移自体は <a> が担い、
  //     送信失敗は遷移をブロックしない (event-beacon が握りつぶす)。adId は ingest 側で当該クラスの
  //     実効広告に実在照合される (#265 L-1) ので、水増しは DB 層でも弾かれる。 ---
  const handleAdTap = useCallback(
    (adId: string, slotIndex: number) => {
      const clientId = getClientId();
      sendSignageEvent(classToken, {
        type: "tap",
        adId,
        slotIndex,
        ...(clientId ? { clientId } : {}),
      });
    },
    [classToken],
  );

  // --- Service Worker 登録 (#48-G)。マウント時に 1 度だけ。失敗しても表示はブロックしない。 ---
  useEffect(() => {
    void registerSignageServiceWorker();
  }, []);

  // --- 広告 media の prefetch / cleanup (#48-G)。media URL 集合が変わった時だけベストエフォートで
  //     温め、現行に無い旧 media を Cache Storage から掃除する。瞬断 (ADR-022) でも cache-first で
  //     last-good を維持。配列参照ではなく URL 集合 (prefetchKey) を依存にし、内容不変なポーリング
  //     (8-12s ごとに新しい配列参照) では再 prefetch しない。 ---
  const prefetchKey = selectPrefetchUrls(ads).join("\n");
  useEffect(() => {
    const urls = prefetchKey ? prefetchKey.split("\n") : [];
    void prefetchMedia(urls);
    void cleanupStaleMedia(urls);
  }, [prefetchKey]);

  if (invalid) {
    return <SignageInvalid />;
  }

  const ad = adCount > 0 ? ads[safeIndex] : null;
  // linkUrl が http(s) 絶対 URL の時だけクリック遷移にする (javascript:/data: 等は弾く = 安全側、ルール)。
  const adLink = ad ? safeHttpUrl(ad.linkUrl) : null;

  return (
    <div style={rootStyle}>
      <main style={contentStyle}>
        <header style={dateHeaderStyle}>{data.date}</header>
        {/* F14 (#128 / ADR-021): 自校地域の天気。weather=null (地域未解決/キャッシュ無し/取得失敗) なら
            枠ごと出さない (fail-soft、画面は壊さない)。端末は外部 API を叩かず本ペイロードを読むだけ。 */}
        {data.weather ? <WeatherWidget weather={data.weather} /> : null}
        <div style={gridStyle}>
          <Section title="時間割" kind="schedules" section={data.daily.schedules} />
          <Section title="連絡" kind="notices" section={data.daily.notices} />
          <Section title="課題" kind="assignments" section={data.daily.assignments} />
          <Section title="静粛時間" kind="quietHours" section={data.daily.quietHours} />
        </div>
      </main>

      <aside aria-label="広告" style={adPaneStyle}>
        {ad ? (
          <figure style={adFigureStyle} key={ad.adId}>
            {adLink ? (
              // linkUrl 付き広告はタップで遷移可能 (インタラクティブ端末)。新規タブ + reverse
              // tabnabbing 防止 (noopener noreferrer)。タップで tap イベントを送る (遷移は阻害しない)。
              <a
                href={adLink}
                target="_blank"
                rel="noopener noreferrer"
                style={adLinkStyle}
                aria-label={ad.caption ? `広告: ${ad.caption}` : "広告を開く"}
                onClick={() => handleAdTap(ad.adId, safeIndex)}
              >
                <AdMedia ad={ad} />
              </a>
            ) : (
              <AdMedia ad={ad} />
            )}
          </figure>
        ) : (
          <p style={adEmptyStyle}>　</p>
        )}
        {adCount > 1 ? <span style={adDotsStyle}>{dots(adCount, safeIndex)}</span> : null}
      </aside>
    </div>
  );
}

function Section({
  title,
  kind,
  section,
}: {
  title: string;
  kind: SignageSectionKind;
  section: MergedSection;
}) {
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
          {section.items.map((item, i) => {
            const line = formatSignageItem(kind, item);
            return (
              // 順序が意味を持ち再並びしない静的リストなので index key で十分。
              // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
              <li key={i} style={line.emphasis ? itemEmphasisStyle : itemStyle}>
                {line.text}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * F14 (#128 / ADR-021): サイネージ天気ウィジェット。`getSignageWeather` が自社 DB から読んだ
 * キャッシュ済み予報 (本日 + 翌日の 2 日) を描画する。**端末は外部 API を叩かない** — 本コンポーネントは
 * server で組んだ `SignageWeather` ペイロードを受け取って表示するだけ (閉域維持、[[closed-system-security]])。
 *
 * a11y (NFR05 / WCAG 2.2 AA): アイコンは **絵文字 glyph + 日本語ラベル併記**で色だけに依存しない
 * (`weatherIconFor` が name/label を必ず返す weather.ts の設計に従う)。気温・降水確率も数値テキストで出す。
 * 鮮度 (F14 §3): `isStale` のとき「最新の取得に失敗」を**色だけでなくテキストで明示**し、いずれの場合も
 * 「○時時点」の取得時刻を併記する。空表示・黙った古値表示はしない (weather=null は呼び出し側で枠ごと非表示)。
 */
function WeatherWidget({ weather }: { weather: SignageWeather }) {
  // 本日 + 翌日の 2 日のみ (視認性、2026-06-03 ユーザー確定 F14 表示範囲)。
  const days = weather.days.slice(0, WEATHER_MAX_DAYS);
  const areaLabel = weather.areaName ? `天気 (${weather.areaName})` : "天気";
  const fetchedNote = formatFetchedNote(weather.fetchedAt);
  return (
    <section aria-label={areaLabel} style={weatherSectionStyle}>
      <h2 style={weatherTitleStyle}>
        <span>{areaLabel}</span>
        {weather.isStale ? (
          // 色のみに頼らずテキストで鮮度劣化を明示 (NFR05)。stale でも last-known-good を出し続ける (NFR02)。
          <span style={weatherStaleBadgeStyle}>最新の取得に失敗（古い予報を表示中）</span>
        ) : null}
      </h2>
      {days.length === 0 ? (
        // days が空でも weather!=null はありうる (将来) ため黙らず注記を出す。
        <p style={emptyStyle}>予報データがありません</p>
      ) : (
        <ol style={weatherDaysStyle}>
          {days.map((day) => (
            <WeatherDayCard key={day.forecastDate} day={day} />
          ))}
        </ol>
      )}
      {fetchedNote ? <p style={weatherFetchedStyle}>{fetchedNote}</p> : null}
    </section>
  );
}

/** 天気 1 日分のカード。アイコン glyph + ラベル + 気温 + 降水確率 をテキスト併記で出す (色非依存、NFR05)。 */
function WeatherDayCard({ day }: { day: WeatherDay }) {
  const glyph = WEATHER_ICON_GLYPH[day.icon];
  return (
    <li style={weatherDayStyle}>
      <span style={weatherDayDateStyle}>{formatDayLabel(day.forecastDate)}</span>
      <span
        // glyph は装飾。意味は隣の iconLabel テキストが担うので読み上げから除外する (二重読み回避)。
        aria-hidden="true"
        style={weatherGlyphStyle}
      >
        {glyph}
      </span>
      {/* 天気テキスト: weatherText があれば優先 (例「晴時々曇」)、無ければアイコンラベル。色に頼らない本文。 */}
      <span style={weatherDayTextStyle}>{day.weatherText ?? day.iconLabel}</span>
      <span style={weatherTempStyle}>{formatTemps(day.tempMax, day.tempMin)}</span>
      <span style={weatherPopStyle}>{formatPop(day.pop)}</span>
    </li>
  );
}

/** 絵文字 glyph (装飾)。意味はラベルテキストが担保するため aria-hidden で出す (NFR05 色非依存)。 */
const WEATHER_ICON_GLYPH: Readonly<Record<WeatherIcon, string>> = {
  sunny: "☀",
  cloudy: "☁",
  rainy: "☂",
  snowy: "❄",
  thunder: "⚡",
  unknown: "？",
};

/** 表示する天気日数の上限 = 本日 + 翌日の 2 日 (2026-06-03 ユーザー確定、視認性優先 F14 表示範囲)。 */
const WEATHER_MAX_DAYS = 2;

/** `YYYY-MM-DD` → サイネージ向けの短い日付ラベル (例「6/2(月)」)。不正値はそのまま返す (落とさない)。 */
function formatDayLabel(forecastDate: string): string {
  const parts = forecastDate.split("-");
  if (parts.length !== 3) {
    return forecastDate;
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return forecastDate;
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return `${m}/${d}(${dow})`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** 最高/最低気温のテキスト。欠損は "—" で埋め空白にしない (色非依存 + 黙らない、NFR05)。 */
function formatTemps(tempMax: number | null, tempMin: number | null): string {
  const hi = tempMax == null ? "—" : `${tempMax}°`;
  const lo = tempMin == null ? "—" : `${tempMin}°`;
  return `最高 ${hi} / 最低 ${lo}`;
}

/** 降水確率のテキスト。null は "—%"。 */
function formatPop(pop: number | null): string {
  return `降水 ${pop == null ? "—" : pop}%`;
}

/** 取得時刻を JST「○時時点」のテキストにする (鮮度注記、F14 §3)。null は注記なし。 */
function formatFetchedNote(fetchedAt: SignageWeather["fetchedAt"]): string | null {
  if (fetchedAt == null) {
    return null;
  }
  const time = new Date(fetchedAt).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${time} 時点`;
}

/** 広告の media (image/video) + caption。リンク有無で <a> でラップされるため共通部品に切り出す。 */
function AdMedia({ ad }: { ad: SignagePayload["ads"][number] }) {
  return (
    <>
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
    </>
  );
}

/**
 * linkUrl が **http(s) の絶対 URL** の時だけ遷移先として採用する。`javascript:` / `data:` 等の
 * 危険スキームや相対・不正値は null に倒し <a> 化しない (XSS/オープンリダイレクト防止 = 安全側)。
 * linkUrl は広告管理で管理者が設定するが、表示層でも多層防御する。
 */
function safeHttpUrl(linkUrl: string | null): string | null {
  if (!linkUrl) {
    return null;
  }
  try {
    const u = new URL(linkUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? linkUrl : null;
  } catch {
    return null;
  }
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
// 重要マーク付き連絡 (isHighlight) は太字で強調する。
const itemEmphasisStyle: React.CSSProperties = { fontSize: "1.1rem", fontWeight: 700 };
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
// リンク付き広告のラッパ。figure の flex 列レイアウトを引き継ぎつつ下線・文字色を継承する。
const adLinkStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  width: "100%",
  height: "100%",
  color: "inherit",
  textDecoration: "none",
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

// --- F14 天気ウィジェット (#128 / ADR-021)。Section と同系統の枠線・余白で既存サイネージ様式に揃える。 ---
const weatherSectionStyle: React.CSSProperties = {
  border: "1px solid #334155",
  borderRadius: "10px",
  padding: "0.75rem 1rem",
  background: "rgba(255,255,255,0.03)",
};
const weatherTitleStyle: React.CSSProperties = {
  fontSize: "1.2rem",
  margin: "0 0 0.5rem",
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.5rem",
};
// 鮮度劣化バッジ。色 (琥珀) に加えテキストで明示し色のみ依存を避ける (NFR05)。
const weatherStaleBadgeStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 700,
  padding: "0.1rem 0.5rem",
  borderRadius: "999px",
  background: "#78350f",
  color: "#fde68a",
};
const weatherDaysStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
  gap: "0.75rem",
};
const weatherDayStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "0.2rem",
  textAlign: "center",
};
const weatherDayDateStyle: React.CSSProperties = { fontSize: "1rem", color: "#cbd5e1" };
const weatherGlyphStyle: React.CSSProperties = { fontSize: "2.2rem", lineHeight: 1 };
const weatherDayTextStyle: React.CSSProperties = { fontSize: "1.1rem", fontWeight: 700 };
const weatherTempStyle: React.CSSProperties = { fontSize: "1rem" };
const weatherPopStyle: React.CSSProperties = { fontSize: "1rem", color: "#93c5fd" };
const weatherFetchedStyle: React.CSSProperties = {
  margin: "0.5rem 0 0",
  fontSize: "0.9rem",
  color: "#94a3b8",
  textAlign: "right",
};
