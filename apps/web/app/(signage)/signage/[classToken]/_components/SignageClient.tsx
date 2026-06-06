"use client";

import type { MergedSection, ScheduleDay } from "@/lib/signage/effective-daily-data";
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
import {
  type SignageScheduleRow,
  formatSignageItem,
  parseAssignmentRow,
  parseScheduleRow,
} from "@/lib/signage/section-format";
import type { SignageDesignPattern } from "@/lib/signage/signage-design";
import type { SignagePayload } from "@/lib/signage/signage-display";
import type { SignageWeather, WeatherIcon } from "@/lib/signage/weather";
import { useCallback, useEffect, useRef, useState } from "react";
import { SignageInvalid } from "./SignageInvalid";
import styles from "./signage.module.css";

/**
 * サイネージ再生制御 Client Island (#48-E2 / F12)。広告ローテーション + 5-10 秒ポーリング自動更新を担う
 * (V1 Firestore `onSnapshot` の置換 / ADR-022 pull 型)。本クライアントに DB アクセスは持ち込まない。
 *
 * **盤面レイアウトは旧キミテラス v1 を忠実移植** (`signage.module.css`):
 *   上段(横幅いっぱい) = 予定(今後3平日の3列・各列5行) / 左下 = 連絡事項(5行) / 右下 = 提出物(表・5行) /
 *   右 = 広告(70:30)。天気は予定の上に小さく1行で残し、静粛時間は盤面に出さない(2026-06-06 ユーザー確定)。
 * 再生・ポーリング・テレメトリ・Service Worker の挙動は #48 系実装をそのまま保持し、本変更は表示層。
 */
const MIN_ROWS = 5;

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
  // ヘッダー帯の実時計。SSR と初回クライアント描画を一致させるため null 始まり、マウント後に effect で埋める。
  const [now, setNow] = useState<Date | null>(null);

  const ads = data.ads;
  const adCount = ads.length;

  // --- 自動更新ポーリング (jitter 付き再帰 setTimeout、tab 非表示時はスキップして接続節約) ---
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
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

  // --- ヘッダー実時計。1 秒ごとに更新。マウント後のみ動く (SSR は時計を出さない)。 ---
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // --- 広告ローテーション (現在広告の duration で次へ。件数変動時は index を丸める) ---
  const safeIndex = clampIndex(adIndex, adCount);
  const adsRef = useRef(ads);
  adsRef.current = ads;
  useEffect(() => {
    if (adCount <= 1) {
      return;
    }
    const ms = clampAdDurationMs(adsRef.current[safeIndex]?.durationSec ?? 0);
    const id = setTimeout(() => setAdIndex((i) => nextIndex(i, adCount)), ms);
    return () => clearTimeout(id);
  }, [safeIndex, adCount]);

  // --- 広告 impression テレメトリ (#43 / F07) + 分粒度ハートビート (#322 / ADR-025)。表示中広告の view を
  //     表示開始時 + `VIEW_HEARTBEAT_MS` ごとに送る。到達は (client_id, ad_id, JST分) で dedup されるので
  //     単一広告クラスの過少計上を解消しつつ水増ししない。tab 非表示中は送らない。送信失敗は表示を妨げない。 ---
  const currentAdId = adCount > 0 ? (ads[safeIndex]?.adId ?? null) : null;
  useEffect(() => {
    if (!currentAdId) {
      return;
    }
    const sendView = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      const clientId = getClientId();
      sendSignageEvent(classToken, {
        type: "view",
        adId: currentAdId,
        slotIndex: safeIndex,
        ...(clientId ? { clientId } : {}),
      });
    };
    sendView();
    const id = setInterval(sendView, VIEW_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [currentAdId, safeIndex, classToken]);

  // --- 広告タップ (click-through) テレメトリ (#43 / F07)。linkUrl 付き広告のタップで tap を 1 件送る。 ---
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

  // --- 広告 media の prefetch / cleanup (#48-G)。URL 集合が変わった時だけ温め、現行に無い旧 media を掃除。 ---
  const prefetchKey = selectPrefetchUrls(ads).join("\n");
  useEffect(() => {
    const urls = prefetchKey ? prefetchKey.split("\n") : [];
    void prefetchMedia(urls);
    void cleanupStaleMedia(urls);
  }, [prefetchKey]);

  if (invalid) {
    return <SignageInvalid />;
  }

  // 配列 index アクセスは T|undefined。盤面コンポーネントへ T|null で渡すため undefined を null に丸める。
  const ad = adCount > 0 ? (ads[safeIndex] ?? null) : null;
  const adLink = ad ? safeHttpUrl(ad.linkUrl) : null;

  // 学校が選んだデザインパターンで盤面コンポーネントを dispatch する（学校別デザイン）。再生制御
  // （ポーリング/ローテーション/テレメトリ/時計）は本コンポーネントが持ち、盤面は表示専用で受け取る。
  return renderDesignBoard(data.designPattern, {
    data,
    ad,
    adLink,
    adCount,
    safeIndex,
    now,
    onAdTap: handleAdTap,
  });
}

/** 各デザインパターンの盤面が受け取る共通 props（再生制御は SignageClient 側、盤面は表示のみ）。 */
type SignageBoardProps = {
  data: SignagePayload;
  ad: SignagePayload["ads"][number] | null;
  adLink: string | null;
  adCount: number;
  safeIndex: number;
  now: Date | null;
  onAdTap: (adId: string, slotIndex: number) => void;
};

/**
 * 学校が選んだデザインパターンに応じた盤面コンポーネントを返す（**学校別デザインの拡張点**）。
 * 現状は `pattern1`（今回作成した v1 レイアウト）のみ。未知/将来パターンは既定 `pattern1` に
 * フォールバックして必ず描画する。将来パターン追加時は case と専用 Board を足すだけで拡張できる。
 */
function renderDesignBoard(pattern: SignageDesignPattern, props: SignageBoardProps) {
  switch (pattern) {
    case "pattern1":
      return <Pattern1Board {...props} />;
    default:
      return <Pattern1Board {...props} />;
  }
}

/**
 * パターン1: 旧キミテラス v1 レイアウト盤面。
 *   上段（横幅いっぱい）= 予定（今後3平日の3列5行）/ 左下 = 連絡 / 右下 = 提出物（表）/ 右 = 広告（70:30）/
 *   天気は予定の上に小さく1行。学校が `pattern1` を選んだとき（既定）に描画される。
 */
function Pattern1Board({ data, ad, adLink, adCount, safeIndex, now, onAdTap }: SignageBoardProps) {
  const hasMedia = ad != null;
  const { dateText, dayText } = formatBoardDate(data.date);
  const time = now ? formatClock(now) : "";

  return (
    <div className={styles.signageRoot}>
      {/* ヘッダー帯（暗色）: 盤面日付 + 曜日 + 天気（日付の隣に小さく）+ 実時計 + ブランディング */}
      <header className={styles.adHeader}>
        <span className={styles.dateText}>{dateText}</span>
        <span className={styles.dayBadge}>{dayText}</span>
        {/* 天気は日付の隣に小さく（日付 + アイコン + 天気テキストのみ。気温/降水/取得時刻は省く、2026-06-07 ユーザー）。 */}
        {data.weather ? <HeaderWeather weather={data.weather} /> : null}
        {time ? <span className={styles.timeText}>{time}</span> : null}
        <span className={styles.headerBranding}>キミテラス by Rebounder</span>
      </header>

      <div className={styles.container}>
        <main className={styles.infoArea}>
          <div className={styles.contentGrid}>
            <ScheduleGrid days={data.scheduleDays} today={data.date} />
            <NoticeList section={data.daily.notices} />
            <AssignmentTable section={data.daily.assignments} today={data.date} />
          </div>
        </main>

        <aside
          aria-label="広告"
          className={`${styles.adArea} ${hasMedia ? styles.adAreaHasMedia : ""}`}
        >
          <div className={styles.adContainer}>
            {ad ? <AdBackdrop key={`bd-${ad.adId}`} ad={ad} /> : null}
            <div className={styles.adForeground}>
              {ad ? (
                adLink ? (
                  <a
                    href={adLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.adLink}
                    aria-label={ad.caption ? `広告: ${ad.caption}` : "広告を開く"}
                    onClick={() => onAdTap(ad.adId, safeIndex)}
                  >
                    <AdMedia key={ad.adId} ad={ad} />
                  </a>
                ) : (
                  <AdMedia key={ad.adId} ad={ad} />
                )
              ) : (
                <p className={styles.adEmpty}>　</p>
              )}
            </div>
            {ad?.caption ? (
              <div
                className={styles.adCaption}
                style={{ "--ad-caption-scale": String(ad.captionFontScale) } as React.CSSProperties}
              >
                {ad.caption}
              </div>
            ) : null}
          </div>
          {adCount > 1 ? <Dots count={adCount} active={safeIndex} /> : null}
        </aside>
      </div>
    </div>
  );
}

/**
 * 予定（今後3平日の3列グリッド）。上段に横幅いっぱいで配置 (v1 ScheduleGrid 移植)。
 * 見出し文字「予定」は出さない（各列の日付ヘッダーで予定と分かる、2026-06-07 ユーザー）。aria-label は
 * 残し、スクリーンリーダ/領域名としての識別は維持する（NFR05）。
 */
function ScheduleGrid({ days, today }: { days: ScheduleDay[]; today: string }) {
  return (
    <section aria-label="予定" className={`${styles.card} ${styles.scheduleSection}`}>
      <div className={styles.scheduleGridContainer}>
        {days.map((day) => (
          <ScheduleColumn key={day.date} day={day} isToday={day.date === today} />
        ))}
      </div>
    </section>
  );
}

/** 予定の 1 日分（1 列）。日付ヘッダー（今日は黒地強調）＋ 時限順の予定行を 5 行分（空きはプレースホルダー）。 */
function ScheduleColumn({ day, isToday }: { day: ScheduleDay; isToday: boolean }) {
  const rows = sortByPeriod(day.schedule.items).map((item) => parseScheduleRow(item));
  const placeholders = Math.max(0, MIN_ROWS - rows.length);
  return (
    <div className={`${styles.scheduleDayColumn} ${isToday ? styles.isToday : ""}`}>
      <div className={styles.scheduleDateHeader}>{scheduleHeaderLabel(day.date)}</div>
      <div className={styles.scheduleScrollArea}>
        {rows.map((row, i) => (
          // 予定は再並びしない静的リスト。index key で十分。
          // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
          <ScheduleRow key={i} row={row} />
        ))}
        {Array.from({ length: placeholders }, (_, i) => {
          // 空きスロットは罫線だけ見せる固定数のプレースホルダー。
          const cls = `${styles.scheduleListItem} ${styles.schedulePlaceholder}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 固定数プレースホルダー
            <div key={`ph-${i}`} className={cls}>
              &nbsp;
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScheduleRow({ row }: { row: SignageScheduleRow }) {
  return (
    <div className={styles.scheduleListItem}>
      <span className={styles.scheduleRowInner}>
        {row.periodLabel ? <span className={styles.scheduleTime}>{row.periodLabel}</span> : null}
        <span className={styles.scheduleContent}>{row.content}</span>
      </span>
    </div>
  );
}

/** 連絡事項（左下・5行）。重要マーク(isHighlight)は赤強調 + 【重要】。空きはプレースホルダーで 5 行を保つ。 */
function NoticeList({ section }: { section: MergedSection }) {
  const lines = section.items.map((item) => formatSignageItem("notices", item));
  const placeholders = Math.max(0, MIN_ROWS - lines.length);
  return (
    <section aria-label="連絡" className={styles.card}>
      <h2 className={styles.cardTitle}>
        連絡
        <SourceBadge source={section.source} />
      </h2>
      <ul className={styles.listGroup}>
        {lines.length === 0 ? (
          <li className={styles.empty}>連絡事項はありません</li>
        ) : (
          <>
            {lines.map((line, i) => {
              const cls = `${styles.listItem} ${line.emphasis ? styles.itemEmphasis : ""}`;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
                <li key={i} className={cls}>
                  {line.emphasis ? "【重要】" : ""}
                  {line.text}
                </li>
              );
            })}
            {Array.from({ length: placeholders }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 固定数プレースホルダー
              <li key={`ph-${i}`} className={styles.noticePlaceholder}>
                &nbsp;
              </li>
            ))}
          </>
        )}
      </ul>
    </section>
  );
}

/** 提出物（右下・表・5行）。期限/科目/提出物の3列。期限切れは赤行、当日/翌日締切は赤文字。空きは行プレースホルダー。 */
function AssignmentTable({ section, today }: { section: MergedSection; today: string }) {
  const rows = section.items
    .map((item) => parseAssignmentRow(item, today))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  const placeholders = Math.max(0, MIN_ROWS - rows.length);
  return (
    <section aria-label="提出物" className={styles.card}>
      <h2 className={styles.cardTitle}>
        提出物
        <SourceBadge source={section.source} />
      </h2>
      <div className={styles.tableWrapper}>
        <table className={styles.taskTable}>
          <thead>
            <tr>
              <th>期限</th>
              <th>科目</th>
              <th>提出物</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className={styles.noAssignment}>
                  提出物はありません
                </td>
              </tr>
            ) : (
              <>
                {rows.map((row, i) => (
                  // 提出物は再並びしない静的リスト。index key で十分。
                  // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
                  <tr key={i} className={row.isOverdue ? styles.overdueRow : ""}>
                    <td>
                      <span
                        className={
                          row.isOverdue || row.isUrgent ? styles.daysUrgent : styles.daysLeft
                        }
                      >
                        {row.daysLeft || row.deadlineShort}
                      </span>
                    </td>
                    <td>{row.subject}</td>
                    <td>{row.task}</td>
                  </tr>
                ))}
                {Array.from({ length: placeholders }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 固定数プレースホルダー
                  <tr key={`ph-${i}`} className={styles.assignmentPlaceholder}>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                    <td>&nbsp;</td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** セクション採用元バッジ（学校共通 / 学年共通）。class 由来・未設定は出さない。 */
function SourceBadge({ source }: { source: MergedSection["source"] }) {
  if (!source || source === "class") {
    return null;
  }
  return (
    <span className={styles.sourceBadge}>{source === "school" ? "学校共通" : "学年共通"}</span>
  );
}

/**
 * F14 (#128 / ADR-021): 天気を **ヘッダーの日付の隣に小さく** 出す（2026-06-07 ユーザー: 情報量を絞る）。
 * 日付 + アイコン + 天気テキストのみ（気温・降水確率・取得時刻は省く）。本日 + 翌日の 2 日。**端末は外部
 * API を叩かず** server 組み立て済ペイロードを描く。a11y (NFR05): glyph は aria-hidden、意味は隣の日本語
 * テキスト（日付 + 天気文）が担う（色のみ依存しない）。鮮度 (F14 §3): isStale のときだけ簡潔に「古い予報」併記。
 * 予報が無いとき (days=[]) はヘッダーに何も足さない（fail-soft、null は呼び出し側で枠ごと非表示）。
 */
function HeaderWeather({ weather }: { weather: SignageWeather }) {
  const days = weather.days.slice(0, WEATHER_MAX_DAYS);
  if (days.length === 0) {
    return null;
  }
  const areaLabel = weather.areaName ? `天気 (${weather.areaName})` : "天気";
  return (
    // ヘッダー内の小さな天気注記をラベル付きグループにする。<fieldset> 等の semantic 要素はフォーム用で
    // ここでは不適。role="group" + aria-label が最小で適切（地域名で天気のまとまりを読み上げに伝える）。
    // biome-ignore lint/a11y/useSemanticElements: 暗色ヘッダー内の inline 天気注記。fieldset は不適切
    <span className={styles.headerWeather} role="group" aria-label={areaLabel}>
      {weather.isStale ? <span className={styles.headerWeatherStale}>古い予報</span> : null}
      {days.map((day) => (
        <span key={day.forecastDate} className={styles.headerWeatherDay}>
          <span className={styles.headerWeatherDate}>{formatDayLabel(day.forecastDate)}</span>
          <span aria-hidden="true" className={styles.headerWeatherGlyph}>
            {WEATHER_ICON_GLYPH[day.icon]}
          </span>
          <span className={styles.headerWeatherText}>{day.weatherText ?? day.iconLabel}</span>
        </span>
      ))}
    </span>
  );
}

/** 予定要素を時限 (period) 昇順に並べる。period 欠損/不正は末尾へ。元配列は破壊しない。 */
function sortByPeriod(items: unknown[]): unknown[] {
  return [...items].sort((a, b) => periodOf(a) - periodOf(b));
}

function periodOf(item: unknown): number {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const p = (item as Record<string, unknown>).period;
    if (typeof p === "number" && Number.isFinite(p)) {
      return p;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** 予定列の日付ヘッダー: `MM/DD (曜)`。不正値は素のまま返す。 */
function scheduleHeaderLabel(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return date;
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return date;
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${mm}/${dd} (${dow})`;
}

/** `YYYY-MM-DD` → 天気の短い日付ラベル (例「6/2(月)」)。不正値はそのまま返す。 */
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

/** ヘッダーの盤面日付ラベル。`data.date` を「YYYY年M月D日」と曜日に整形する (TZ ドリフト回避に Date.UTC)。 */
function formatBoardDate(date: string): { dateText: string; dayText: string } {
  const parts = date.split("-");
  if (parts.length !== 3) {
    return { dateText: date, dayText: "" };
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { dateText: date, dayText: "" };
  }
  const dow = WEEKDAY_JA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  return { dateText: `${y}年${m}月${d}日`, dayText: dow };
}

/** 実時計 HH:MM (JST)。 */
function formatClock(d: Date): string {
  return d.toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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

/** 表示する天気日数の上限 = 本日 + 翌日の 2 日。 */
const WEATHER_MAX_DAYS = 2;

/** 広告の背景ぼかし (v1 adBackdrop)。前景と同じ media を cover + blur で敷き余白を隠す。 */
function AdBackdrop({ ad }: { ad: SignagePayload["ads"][number] }) {
  if (ad.mediaType === "video") {
    return (
      // 装飾用の背景ぼかし動画。controls 無し = フォーカス不可で、前景動画の複製なので AT から隠す。
      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: controls 無しの装飾複製背景（非フォーカス）
      <video
        className={styles.adBackdrop}
        src={ad.mediaUrl}
        muted
        autoPlay
        loop
        playsInline
        aria-hidden="true"
      />
    );
  }
  return <img className={styles.adBackdrop} src={ad.mediaUrl} alt="" aria-hidden="true" />;
}

/** 広告の前景 media (image/video)。リンク有無で <a> でラップされるため共通部品に切り出す。 */
function AdMedia({ ad }: { ad: SignagePayload["ads"][number] }) {
  if (ad.mediaType === "video") {
    return <video src={ad.mediaUrl} autoPlay muted loop playsInline className={styles.adMedia} />;
  }
  return <img src={ad.mediaUrl} alt={ad.caption ?? ""} className={styles.adMedia} />;
}

/**
 * linkUrl が **http(s) の絶対 URL** の時だけ遷移先として採用する。`javascript:` / `data:` 等の
 * 危険スキームや相対・不正値は null に倒し <a> 化しない (XSS/オープンリダイレクト防止 = 安全側)。
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

/** ローテーション位置のドット表示 (現在位置を塗り、他を半透明に)。 */
function Dots({ count, active }: { count: number; active: number }) {
  return (
    <div className={styles.adDots} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const cls = `${styles.dot} ${i === active ? styles.dotActive : ""}`;
        // 固定長の装飾ドット列。index key で十分。
        // biome-ignore lint/suspicious/noArrayIndexKey: 不変ドット列の描画
        return <span key={i} className={cls} />;
      })}
    </div>
  );
}
