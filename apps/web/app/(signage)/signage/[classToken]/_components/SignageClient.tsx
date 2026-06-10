"use client";

import { formatClassIdentity } from "@/lib/signage/class-identity";
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
import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import type { SignagePayload } from "@/lib/signage/signage-display";
import type { SignageWeather, WeatherDay, WeatherIcon } from "@/lib/signage/weather";
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
  // 端末別デザイン（このページは ?design 付き URL でロードされ、初期 payload に反映済み）。ポーリングでも
  // 同じデザインを引き継ぐため poll URL に転送する（転送しないと data Route が学校レベル既定/pattern1 に
  // 倒れ初回ポーリングで盤面が切替わってしまう）。ページセッション中は不変なので initial 値を固定で使う。
  const designParam = initial.designPattern;

  // --- 自動更新ポーリング (jitter 付き再帰 setTimeout、tab 非表示時はスキップして接続節約) ---
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    try {
      const res = await fetch(
        `/signage/${encodeURIComponent(classToken)}/data?date=${jstDateString()}&design=${encodeURIComponent(designParam)}`,
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
  }, [classToken, designParam]);

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
 * 学校 / 端末が選んだデザインパターンに応じた盤面コンポーネントを返す（**デザインの拡張点**）。
 * `pattern1` = 旧キミテラス v1 レイアウト（既定）/ `pattern2` = 予定・来校者・呼び出し・センサ・天気・鉄道の
 * 掲示盤面。未知 / 将来パターンは既定 `pattern1` にフォールバックして必ず描画する（fail-soft）。将来パターン
 * 追加時は case と専用 Board を足すだけで拡張できる。再生制御（ポーリング/ローテーション/テレメトリ/時計）は
 * `SignageClient` が持ち、各 Board は表示専用で共通 props を受け取る。広告（右）と上部ヘッダーは両パターン共通。
 */
function renderDesignBoard(pattern: SignageDesignPattern, props: SignageBoardProps) {
  switch (pattern) {
    case "pattern2":
      return <Pattern2Board {...props} />;
    default:
      return <Pattern1Board {...props} />;
  }
}

/** 全盤面共通のヘッダー帯（暗色）: 盤面日付 + 曜日 + 実時計 + クラス識別（#243）+ ブランディング。 */
function BoardHeader({ data, now }: { data: SignagePayload; now: Date | null }) {
  const { dateText, dayText } = formatBoardDate(data.date);
  const time = now ? formatClock(now) : "";
  // #243: このサイネージの識別ラベル（学科 学年 クラス）。時刻の横に出してどの端末か判別できるようにする。
  const classIdentity = formatClassIdentity(data.classContext);
  return (
    <header className={styles.adHeader}>
      <span className={styles.dateText}>{dateText}</span>
      <span className={styles.dayBadge}>{dayText}</span>
      {time ? <span className={styles.timeText}>{time}</span> : null}
      {classIdentity ? (
        <span className={styles.classIdentity} aria-label={`表示クラス: ${classIdentity}`}>
          {classIdentity}
        </span>
      ) : null}
      <span className={styles.headerBranding}>キミテラス by Rebounder</span>
    </header>
  );
}

/**
 * 全盤面共通の広告エリア（右 30%・暗色ゾーン + ぼかし背景 + 前景 media + キャプション + ドット）。
 * パターン2 でも「右側の広告はパターン1と同じ」（ユーザー指定）。再生制御は SignageClient が持ち、本部品は
 * 現在広告とタップ配線（#43 / F07）を受け取って描画する。
 */
function AdAside({
  ad,
  adLink,
  adCount,
  safeIndex,
  onAdTap,
}: {
  ad: SignageBoardProps["ad"];
  adLink: string | null;
  adCount: number;
  safeIndex: number;
  onAdTap: SignageBoardProps["onAdTap"];
}) {
  const hasMedia = ad != null;
  return (
    <aside
      aria-label="広告"
      className={`${styles.adArea} ${hasMedia ? styles.adAreaHasMedia : ""}`}
    >
      {ad ? (
        adLink ? (
          // 広告領域**全体**をタップで遷移（管理で設定した linkUrl）。新規タブ + reverse tabnabbing
          // 防止 (noopener noreferrer)。タップで tap テレメトリを送る（遷移は阻害しない）。adId は
          // ingest 側で当該クラスの実効広告に実在照合される（水増しは DB 層でも弾く）。
          <a
            href={adLink}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.adAreaLink}
            aria-label={ad.caption ? `広告: ${ad.caption}` : "広告を開く"}
            onClick={() => onAdTap(ad.adId, safeIndex)}
          >
            <AdInner ad={ad} />
          </a>
        ) : (
          <AdInner ad={ad} />
        )
      ) : (
        <div className={styles.adContainer}>
          <div className={styles.adForeground}>
            <p className={styles.adEmpty}>　</p>
          </div>
        </div>
      )}
      {adCount > 1 ? <Dots count={adCount} active={safeIndex} /> : null}
    </aside>
  );
}

/**
 * パターン1: 旧キミテラス v1 レイアウト盤面（既定）。
 *   上段（横幅いっぱい）= 予定（今後3平日の3列5行）/ 左下 = 連絡 / 右下 = 提出物（表）/ 右 = 広告（70:30）/
 *   天気は予定列の日付横。`pattern1`（既定）選択時に描画される。
 */
function Pattern1Board({ data, ad, adLink, adCount, safeIndex, now, onAdTap }: SignageBoardProps) {
  return (
    <div className={styles.signageRoot}>
      <BoardHeader data={data} now={now} />
      <div className={styles.container}>
        <main className={styles.infoArea}>
          <div className={styles.contentGrid}>
            <ScheduleGrid
              days={data.scheduleDays}
              today={data.date}
              weather={data.weather ?? null}
            />
            <NoticeList section={data.daily.notices} />
            <AssignmentTable section={data.daily.assignments} today={data.date} />
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
        />
        {/* モバイル限定フッター（順序: タブ→広告→予定→連絡→提出物→フッター）。デスクトップは非表示。 */}
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
}

/**
 * パターン2: 掲示盤面（予定 / 来校者一覧 / 生徒呼び出し / 人感センサカウンタ / 天気予報 / 鉄道）。右側の広告は
 * パターン1と同一（`AdAside` 共有・ユーザー指定）。
 *
 * **本 PR は「TVデバイスごとの切替の仕組み」+「パターン2のレイアウト骨格」**まで。予定・天気は既存データで
 * 実描画し、来校者 / 呼び出し / センサ / 鉄道は後続スライス（データモデル・エディタ・外部取得 Job）まで
 * 「準備中」プレースホルダーを出す。これで admin/tv-devices から端末ごとに P1/P2 を切替えられることを保証し、
 * 各ウィジェットは別 PR で中身を詰める（盤面は壊さない＝fail-soft）。
 */
function Pattern2Board({ data, ad, adLink, adCount, safeIndex, now, onAdTap }: SignageBoardProps) {
  return (
    <div className={styles.signageRoot}>
      <BoardHeader data={data} now={now} />
      <div className={styles.container}>
        <main className={styles.infoArea}>
          <div className={styles.p2Grid}>
            <Pattern2Schedule days={data.scheduleDays} today={data.date} />
            <Pattern2Weather weather={data.weather ?? null} />
            <Pattern2Placeholder title="来校者一覧" />
            <Pattern2Placeholder title="生徒呼び出し" />
            <Pattern2SensorCount count={data.presenceCount} />
            <Pattern2Placeholder title="鉄道" />
          </div>
        </main>
        <AdAside
          ad={ad}
          adLink={adLink}
          adCount={adCount}
          safeIndex={safeIndex}
          onAdTap={onAdTap}
        />
        <footer className={styles.mobileFooter}>キミテラス by Rebounder</footer>
      </div>
    </div>
  );
}

/**
 * パターン2の予定（横幅いっぱい・今後3平日の3列）。day/曜（列ヘッダー）+ 時限 + 内容（科目・補足）に加え、
 * **場所 / 対象者**（任意・教員がエディタで入力）を各コマの下に小さく添える（PR3）。未設定の場所/対象者は
 * 行を出さない（fail-soft、盤面を詰めて見せる）。
 */
function Pattern2Schedule({ days, today }: { days: ScheduleDay[]; today: string }) {
  return (
    <section aria-label="予定" className={`${styles.card} ${styles.p2Wide}`}>
      <h2 className={styles.cardTitle}>予定</h2>
      <div className={styles.p2ScheduleScroll}>
        {days.map((day) => {
          const rows = sortByPeriod(day.schedule.items).map((item) => parseScheduleRow(item));
          const isToday = day.date === today;
          return (
            <div
              key={day.date}
              className={`${styles.p2ScheduleDay} ${isToday ? styles.p2ScheduleToday : ""}`}
            >
              <span className={styles.p2ScheduleDate}>{scheduleHeaderLabel(day.date)}</span>
              <div className={styles.p2ScheduleRows}>
                {rows.length === 0 ? (
                  <span className={styles.p2Muted}>予定はありません</span>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 不変リストの描画
                  rows.map((row, i) => <Pattern2ScheduleRow key={i} row={row} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** パターン2 予定の 1 コマ: 時限 + 内容、その下に 場所 / 対象者（あるものだけ）を小さく添える。 */
function Pattern2ScheduleRow({ row }: { row: SignageScheduleRow }) {
  const hasMeta = row.location != null || row.targetAudience != null;
  return (
    <div className={styles.p2ScheduleItem}>
      <span className={styles.p2ScheduleMain}>
        {row.periodLabel ? <span className={styles.scheduleTime}>{row.periodLabel}</span> : null}
        {row.content}
      </span>
      {hasMeta ? (
        <span className={styles.p2ScheduleMeta}>
          {row.location ? <span>場所: {row.location}</span> : null}
          {row.location && row.targetAudience ? (
            <span aria-hidden="true" className={styles.p2ScheduleMetaSep}>
              ／
            </span>
          ) : null}
          {row.targetAudience ? <span>対象: {row.targetAudience}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** パターン2の天気予報（既存 weather を流用）。未取得は fail-soft でセクションを残し「準備中」表示にしない。 */
function Pattern2Weather({ weather }: { weather: SignageWeather | null }) {
  const hasDays = weather != null && weather.days.length > 0;
  return (
    <section aria-label="天気予報" className={styles.card}>
      <h2 className={styles.cardTitle}>天気予報</h2>
      {hasDays ? (
        <div className={styles.p2WeatherRow}>
          {weather.days.map((d) => (
            <div key={d.forecastDate} className={styles.p2WeatherDay}>
              <span className={styles.p2WeatherDate}>{scheduleHeaderLabel(d.forecastDate)}</span>
              <span aria-hidden="true" className={styles.p2WeatherGlyph}>
                {WEATHER_ICON_GLYPH[d.icon]}
              </span>
              <span className={styles.p2WeatherText}>{d.weatherText ?? d.iconLabel}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className={styles.p2Muted}>天気情報はありません</p>
      )}
    </section>
  );
}

/**
 * パターン2の人感センサカウンタ（F13 / ADR-020）。このクラスの **本日の検知回数（累計）** を表示する。
 * PIR は瞬間検知で滞在時間を測れない（ADR-020）ため「在室人数」ではなく「本日何回検知したか」を出す
 * （2026-06-10 ユーザー確定）。件数は `getTodayPresenceCount`（RLS 自校限定）由来。取得失敗（`null`）は
 * 「計測なし」表示に倒す（fail-soft）。検知ゼロは `0 回` を出す（センサーは在るが今日まだ反応なし）。
 */
function Pattern2SensorCount({ count }: { count: number | null }) {
  return (
    <section aria-label="人感センサカウンタ" className={styles.card}>
      <h2 className={styles.cardTitle}>人感センサカウンタ</h2>
      {count == null ? (
        <p className={styles.p2Muted}>計測なし</p>
      ) : (
        <div className={styles.p2SensorCount}>
          <span className={styles.p2SensorNum}>{count.toLocaleString("ja-JP")}</span>
          <span className={styles.p2SensorUnit}>回</span>
          <span className={styles.p2SensorLabel}>本日の検知</span>
        </div>
      )}
    </section>
  );
}

/**
 * パターン2の未実装ウィジェット枠（来校者一覧 / 生徒呼び出し / 鉄道）。後続スライスで中身を実装するまで
 * 盤面骨格を見せつつ「準備中」を明示する（端末別切替の検証を妨げない）。
 */
function Pattern2Placeholder({ title }: { title: string }) {
  return (
    <section aria-label={title} className={styles.card}>
      <h2 className={styles.cardTitle}>{title}</h2>
      <p className={styles.p2Placeholder}>準備中</p>
    </section>
  );
}

/**
 * 予定（今後3平日の3列グリッド）。上段に横幅いっぱいで配置 (v1 ScheduleGrid 移植)。
 * 各列の日付ヘッダーに当日の天気を横並びで表示する（2026-06-07 ユーザー）。天気が古い場合は
 * F14 §3 要件に従い「古い予報」バッジをセクション右端に表示する。aria-label は
 * 残し、スクリーンリーダ/領域名としての識別は維持する（NFR05）。
 */
function ScheduleGrid({
  days,
  today,
  weather,
}: {
  days: ScheduleDay[];
  today: string;
  weather: SignageWeather | null;
}) {
  return (
    <section aria-label="予定" className={`${styles.card} ${styles.scheduleSection}`}>
      {weather?.isStale ? (
        <span className={styles.scheduleStaleNotice} role="status" aria-live="polite">
          古い予報
        </span>
      ) : null}
      <div className={styles.scheduleGridContainer}>
        {days.map((day) => {
          const weatherDay = weather?.days.find((d) => d.forecastDate === day.date) ?? null;
          return (
            <ScheduleColumn
              key={day.date}
              day={day}
              isToday={day.date === today}
              weatherDay={weatherDay}
            />
          );
        })}
      </div>
    </section>
  );
}

/** 予定の 1 日分（1 列）。日付ヘッダー（今日は黒地強調）に天気を横並びで表示。5 行分の予定行（空きはプレースホルダー）。 */
function ScheduleColumn({
  day,
  isToday,
  weatherDay,
}: {
  day: ScheduleDay;
  isToday: boolean;
  weatherDay: WeatherDay | null;
}) {
  const rows = sortByPeriod(day.schedule.items).map((item) => parseScheduleRow(item));
  const placeholders = Math.max(0, MIN_ROWS - rows.length);
  return (
    <div className={`${styles.scheduleDayColumn} ${isToday ? styles.isToday : ""}`}>
      <div className={styles.scheduleDateHeader}>
        <span className={styles.scheduleDateLabel}>{scheduleHeaderLabel(day.date)}</span>
        {weatherDay ? (
          <span
            className={styles.scheduleWeatherInline}
            aria-label={weatherDay.weatherText ?? weatherDay.iconLabel}
          >
            <span aria-hidden="true" className={styles.scheduleWeatherGlyph}>
              {WEATHER_ICON_GLYPH[weatherDay.icon]}
            </span>
            <span className={styles.scheduleWeatherText}>
              {weatherDay.weatherText ?? weatherDay.iconLabel}
            </span>
          </span>
        ) : null}
      </div>
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

/** セクション採用元バッジ（学校共通 / 学科共通 / 学年共通）。class 由来・未設定は出さない。 */
function SourceBadge({ source }: { source: MergedSection["source"] }) {
  if (!source || source === "class") {
    return null;
  }
  return <span className={styles.sourceBadge}>{SOURCE_BADGE_LABEL[source]}</span>;
}

/** 採用元 scope → サイネージ継承バッジ文言。class は出さないので含めない。 */
const SOURCE_BADGE_LABEL: Record<"school" | "department" | "grade", string> = {
  school: "学校共通",
  department: "学科共通",
  grade: "学年共通",
};

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

/**
 * 広告の中身（ぼかし背景 + 前景 media + キャプション）。リンク有無で <a> でラップされ広告領域全体を
 * タップ可能にするため、中身を共通部品に切り出す。ad 変更で AdBackdrop/AdMedia の key を変えて差し替える。
 */
function AdInner({ ad }: { ad: SignagePayload["ads"][number] }) {
  return (
    <div className={styles.adContainer}>
      <AdBackdrop key={`bd-${ad.adId}`} ad={ad} />
      <div className={styles.adForeground}>
        <AdMedia key={ad.adId} ad={ad} />
      </div>
      {ad.caption ? (
        <div
          className={styles.adCaption}
          style={{ "--ad-caption-scale": String(ad.captionFontScale) } as React.CSSProperties}
        >
          {ad.caption}
        </div>
      ) : null}
    </div>
  );
}

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
