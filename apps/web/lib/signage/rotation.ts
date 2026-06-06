/**
 * サイネージ再生制御の**純粋ロジック** (#48-E2 / F12)。DB・DOM 非依存でユニットテスト可能。
 *
 * #48-E1 が「いま表示すべき確定状態」を静的描画したのに対し、#48-E2 は Client Island で
 * (a) 広告ローテーション (1 件ずつ duration 秒で巡回) と (b) 5-10 秒ポーリングによる自動更新を
 * 担う。V1 の Firestore `onSnapshot` リアルタイム購読を**短ポーリングに置換**する
 * (ADR-022: 学校 Wi-Fi はアウトバウンドのみ前提、pull 型に統一 / v1-v2-mapping §Firebase API 置換)。
 *
 * **ポーリング間隔の根拠 (NFR01 突合)**: 既定 10 秒 (`POLL_BASE_MS`)。v1-v2-mapping が懸念した
 * 「50 台/校 × 5 秒 = 10 req/s/校」を、サイネージは描画頻度が低い (連絡・時間割は分〜時間単位で変化)
 * ため **10 秒に倍化して 5 req/s/校** に抑える。さらに端末ごとに ±20% のジッタ (`POLL_JITTER_RATIO`)
 * を掛け、50 台の更新が同一秒に重ならないよう**位相をばらして** Cloud SQL 接続のバースト
 * (= 1 リクエスト 1 トランザクション 1 コネクション) を平準化する。詳細な接続試算は
 * `signage-display.ts` 冒頭コメント参照。
 */

/** ポーリング基準間隔 (ms)。NFR01 突合の結果 5 秒 → 10 秒に倍化 (上記コメント)。 */
export const POLL_BASE_MS = 10_000;

/** ポーリング間隔のジッタ比率 (±20%)。50 台の更新位相をばらし接続バーストを避ける。 */
export const POLL_JITTER_RATIO = 0.2;

/** 広告 1 件の表示時間の下限・上限 (ms)。0/欠損/極端値を実用域へ丸める。 */
export const MIN_AD_MS = 3_000;
export const MAX_AD_MS = 120_000;
/** durationSec が不正 (<=0 / 非有限) なときの既定表示時間 (ms)。 */
export const DEFAULT_AD_MS = 10_000;

/**
 * 広告 view (impression) の**分粒度ハートビート間隔** (ms)。表示中の広告について端末がこの間隔で
 * `view` を再送する (#322 / ADR-025 クライアント送信契約)。
 *
 * 到達数 (reach) は集計時に `(client_id, ad_id, JST 分)` で重複排除される (`getAdReach`) ため、
 * 1 分間隔の再送は「表示し続けた各分に最低 1 件の view が立つ」ことを保証し、ローテーションせず
 * マウント中 1 回しか view を送らなかった**単一広告クラスの到達過少計上を解消**する。複数広告クラス
 * (ローテーションで自然に再送) と**枚数に依らず公平**になる。同一分内の重複は dedup で 1 に集約される
 * ため、この再送が到達数を水増しすることはない (延べ表示数 = engagement のみ増えるが ADR-025 で許容)。
 * マウント時刻が端末ごとに異なるため送信位相は自然にばらけ、ポーリングと違い Cloud SQL を直接
 * 叩かない append-only beacon なので 50 台規模でもバーストにならない。
 */
export const VIEW_HEARTBEAT_MS = 60_000;

/**
 * 広告の `durationSec` を実用域の ms に丸める。非有限/0 以下は既定値、範囲外はクランプ。
 * 端末側で異常データに引きずられて「広告が一瞬で切り替わる/固まる」のを防ぐ。
 */
export function clampAdDurationMs(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return DEFAULT_AD_MS;
  }
  const ms = durationSec * 1_000;
  return Math.min(MAX_AD_MS, Math.max(MIN_AD_MS, ms));
}

/**
 * ローテーションの次インデックス。空 (length<=0) は 0、それ以外は循環。
 * ポーリングで広告件数が変わっても範囲外を指さないよう、呼び出し側は現在 index に
 * `clampIndex` を併用する。
 */
export function nextIndex(current: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return (current + 1) % length;
}

/** 件数変動時に現在 index を有効範囲へ丸める (件数減で範囲外を指すのを防ぐ)。 */
export function clampIndex(current: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return current % length;
}

/**
 * ポーリング間隔にジッタを掛けた ms を返す。`rnd` は [0,1) の乱数源 (既定 Math.random、
 * テストでは固定値を注入)。50 台の更新位相をばらすのが目的。
 */
export function jitteredPollMs(
  baseMs: number = POLL_BASE_MS,
  ratio: number = POLL_JITTER_RATIO,
  rnd: () => number = Math.random,
): number {
  const delta = (rnd() * 2 - 1) * ratio * baseMs;
  return Math.max(MIN_AD_MS, Math.round(baseMs + delta));
}

/**
 * JST (Asia/Tokyo) の YYYY-MM-DD。端末のブラウザ TZ に依存せず日本時間の「今日」を出す
 * (深夜 0 時を跨いだら翌日分へ自動で切り替わる)。`now` 注入でテスト可能。
 */
export function jstDateString(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

/**
 * サイネージ「予定」グリッドの列日付 (今後 `count` 日ぶん) を YYYY-MM-DD で返す。
 *
 * v1 ScheduleGrid の「今後 3 平日」を移植しつつ、**先頭列は常に基準日 (`fromDate` = 表示中の今日) を
 * 固定**し、2 列目以降を翌日からの**平日** (土日スキップ) で埋める。
 *   - `fromDate` が平日なら結果は v1 の「今後 N 平日」と完全一致 (例: 金 → [金, 月, 火])。
 *   - `fromDate` が土日のときだけ v1 と異なり、先頭にその週末日を置く (例: 土 → [土, 月, 火])。学校は
 *     休業日だが「今日」を必ず先頭に出す方が盤面の一貫性が高く、休日でも欠落しない (週末は予定が空なら
 *     プレースホルダー 5 行になるだけ)。
 *
 * 暦日演算は UTC 上で行い端末 TZ に依存しない (jstDateString で解決した JST 暦日文字列をそのまま日付
 * として扱う)。不正な日付文字列・count<=0 は空配列を返す (呼び出し側で fail-soft)。
 */
export function signageScheduleDates(fromDate: string, count: number): string[] {
  const parts = fromDate.split("-");
  if (parts.length !== 3 || count <= 0) {
    return [];
  }
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const base = new Date(Date.UTC(y, m - 1, d));
  // 実在暦日でなければ空 (parseSignageDate と同じ round-trip 検証)。
  if (!(base.getUTCFullYear() === y && base.getUTCMonth() === m - 1 && base.getUTCDate() === d)) {
    return [];
  }
  const fmt = (t: number): string => {
    const dt = new Date(t);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${dt.getUTCFullYear()}-${mm}-${dd}`;
  };
  // 先頭列は基準日を固定 (週末でも今日を出す)。
  const out: string[] = [fmt(base.getTime())];
  let cursor = base.getTime() + 86_400_000; // 翌日から
  // 残り列を平日で埋める。反復は最大 count+土日ぶん。暴走防止に上限を設ける。
  for (let i = 0; out.length < count && i < count + 7; i++) {
    const dow = new Date(cursor).getUTCDay(); // 0=日, 6=土
    if (dow !== 0 && dow !== 6) {
      out.push(fmt(cursor));
    }
    cursor += 86_400_000; // +1 日 (UTC は DST 無しなので安全)。
  }
  return out;
}

/** `YYYY-MM-DD` のフォーマット。実在暦日かは {@link parseSignageDate} が round-trip で別途検証する。 */
const SIGNAGE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * サイネージの `?date=` クエリを安全な `YYYY-MM-DD` (JST) に解決する。
 *
 * フォーマット (`SIGNAGE_DATE_RE`) **だけでなく実在する暦日か**まで検証する。`2026-13-45` /
 * `2026-02-31` / `0000-00-00` 等は regex を通過するが、`daily_data.date` は pg の `date` 型
 * (`mode:"string"`) で素の文字列を bind するため、無効暦日は `WHERE date = '2026-13-45'` で
 * pg が "date/time field value out of range" を投げ、ハンドラ側に try/catch が無いと 500 になる
 * (CWE-20)。実在性は `Date.UTC` で組み立て直して各フィールドが一致するか (round-trip) で判定し、
 * 形式不正・無効暦日・未指定はいずれも JST の今日 ({@link jstDateString}) にフォールバックする。
 *
 * @param dateParam URL クエリの生値 (null/undefined 可)。
 * @param now       フォールバックの「今日」を決める基準時刻 (テスト注入用)。
 */
export function parseSignageDate(
  dateParam: string | null | undefined,
  now: Date = new Date(),
): string {
  if (dateParam && SIGNAGE_DATE_RE.test(dateParam)) {
    const parts = dateParam.split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    // round-trip: 桁溢れ (13 月 / 45 日 / 02-31) は Date.UTC が別の月日へ繰り上がり一致しない。
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day) {
      return dateParam;
    }
  }
  return jstDateString(now);
}
