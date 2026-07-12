/**
 * サイネージ「授業時間中の広告配信停止」の **型・純ロジック（単一ソース）**。
 *
 * システム管理者が学校ごとに「授業時間（＝広告を止める時間帯）」を設定し、その時間帯はサイネージ盤面の
 * 広告枠だけを空にする（時間割・連絡・提出物など他ブロックは通常どおり出す）。実機端末は既存の 10 秒
 * ポーリングで追従するので、端末（APK）改修も migration も不要。
 *
 * ## 保存先（migration 不要・display_settings 相乗り）
 * 新しい `config_kind` enum 値は足さず、学校スコープ `school_configs`（scope='school',
 * kind='display_settings'）の `value.adSuppression` に持たせる（黒画面トグル {@link ./blackout} と同方針）。
 * 同じ行の `signageDesign` / `assignmentDeadlineFormat` / `editorDayCutover` とは別キーなので衝突しない。
 * 値の形は `{ enabled, ranges: [{ start:"HH:MM", end:"HH:MM" }], weekdays:number[] }`。
 *
 * ## client-safe（drizzle / postgres を import しない）
 * このファイルは純ロジックだけを持ち、設定フォーム（"use client" な `AdSuppressionManager`）と
 * サイネージ配信層（server の `signage-display.ts`）・Server Action の**両方**から安全に import できる。
 * DB 読み取りは呼び出し側が既に取得済みの `display_settings` value を {@link parseAdSuppression} に渡す
 * （`buildSignagePayloadForClass` は 1 度読んだ value を各 parse に通す規約なので追加 round-trip は無い）。
 *
 * ## fail-soft の向き（広告は「出る」側に倒す）
 * 黒画面（盤面を隠す）は false（出す）に倒すのと同様だが、本機能は逆に **停止条件を満たさない＝広告を出す**
 * を既定にする。設定の読み取り失敗・壊れた値・enabled=false・時間帯 0 件はすべて「停止しない（＝広告を出す）」。
 * 事故で広告が全断する（商流の損失）より、事故で広告が出続ける方が安全側という判断。
 */

/** `display_settings` value に相乗りする本機能のキー。 */
export const AD_SUPPRESSION_KEY = "adSuppression" as const;

/** 暴走入力（巨大配列）を防ぐ実務上限。1 校の授業時間帯は十数コマで十分。 */
export const MAX_AD_SUPPRESSION_RANGES = 24;

/** 既定の対象曜日（月〜金）。未設定・不正はこれに倒す（v1 の授業日 = 平日と一貫）。 */
export const DEFAULT_AD_SUPPRESSION_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** "HH:MM" 24 時間表記（00:00〜23:59）。 */
const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** 検証済みの 1 時間帯（同日内・start < end）。DB / 判定へそのまま渡せる正規化済みの値。 */
export type AdSuppressionRange = { start: string; end: string };

/** 授業時間（広告停止）設定の本体。`school_configs.value.adSuppression` に格納する形。 */
export type AdSuppressionConfig = {
  /** 機能全体の有効/無効。false なら時間帯があっても停止しない（＝常に広告を出す）。 */
  enabled: boolean;
  /** 広告を止める時間帯（各 `{ start, end }` は "HH:MM"・同日内）。空なら停止しない。 */
  ranges: AdSuppressionRange[];
  /** 対象曜日（0=日..6=土）。空配列は「全曜日」を意味する。既定は月〜金。 */
  weekdays: number[];
};

/** "HH:MM" を 0..1439 の分数に変換する。形式不正は null。 */
function toMinutes(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const m = TIME_RE.exec(value.trim());
  if (!m) {
    return null;
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

/** `ranges`（unknown JSONB）を防御的に range 配列へ復元する。start/end が "HH:MM" の要素だけ残す。 */
function readRanges(value: unknown): AdSuppressionRange[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: AdSuppressionRange[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (toMinutes(rec.start) !== null && toMinutes(rec.end) !== null) {
      out.push({ start: (rec.start as string).trim(), end: (rec.end as string).trim() });
    }
  }
  return out;
}

/** `weekdays`（unknown JSONB）を防御的に 0..6 の整数配列へ復元する。未設定・不正は既定（月〜金）。 */
function readWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_AD_SUPPRESSION_WEEKDAYS];
  }
  const seen = new Set<number>();
  for (const d of value) {
    if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6) {
      seen.add(d);
    }
  }
  // 空配列（＝全曜日オフ）はそのまま尊重すると全曜日オフで永久に停止しなくなるが、それは利用者の明示的な
  // 選択（対象曜日なし＝停止なし）として許容する。壊れた（非配列）値だけ既定に倒す。
  return [...seen].sort((a, b) => a - b);
}

/**
 * 学校スコープ `display_settings` の value（opaque JSONB）から授業時間（広告停止）設定を **防御的に**取り出す。
 * キー欠落・型不一致・壊れた値はすべて `{ enabled:false, ranges:[], weekdays:既定 }`（＝停止しない）に倒す。
 */
export function parseAdSuppression(configValue: unknown): AdSuppressionConfig {
  const fallback: AdSuppressionConfig = {
    enabled: false,
    ranges: [],
    weekdays: [...DEFAULT_AD_SUPPRESSION_WEEKDAYS],
  };
  if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) {
    return fallback;
  }
  const raw = (configValue as Record<string, unknown>)[AD_SUPPRESSION_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fallback;
  }
  const rec = raw as Record<string, unknown>;
  return {
    enabled: rec.enabled === true,
    ranges: readRanges(rec.ranges),
    weekdays: readWeekdays(rec.weekdays),
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * `now`（絶対時刻）を **JST の曜日（0=日..6=土）と 0 時からの分**に変換する（端末/サーバ TZ 非依存）。
 * `default-date.ts` の `jstMinutes` と同じ Intl.DateTimeFormat(Asia/Tokyo, h23) 作法。
 */
export function jstWeekdayAndMinutes(now: Date): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { weekday: WEEKDAY_INDEX[wd] ?? -1, minutes: hour * 60 + minute };
}

/**
 * JST 曜日・分から「いま広告を停止すべきか」を判定する純関数（テスト用に時刻依存を切り離した本体）。
 * enabled でない / 時間帯 0 件 / 対象曜日外 は停止しない。各 range は `[start, end)`（終了時刻ちょうどは
 * 停止しない＝授業終了で広告が戻る）。
 */
export function isSuppressedAtMinutes(
  config: AdSuppressionConfig,
  weekday: number,
  minutes: number,
): boolean {
  if (!config.enabled || config.ranges.length === 0) {
    return false;
  }
  if (!config.weekdays.includes(weekday)) {
    return false;
  }
  return config.ranges.some((r) => {
    const start = toMinutes(r.start);
    const end = toMinutes(r.end);
    return start !== null && end !== null && minutes >= start && minutes < end;
  });
}

/**
 * `now`（絶対時刻）時点で当校のサイネージ広告を停止すべきか。{@link jstWeekdayAndMinutes} で JST に落とし
 * {@link isSuppressedAtMinutes} に委譲する。サイネージ配信層（live 経路のみ）から呼ぶ。
 */
export function isAdSuppressedAt(config: AdSuppressionConfig, now: Date): boolean {
  const { weekday, minutes } = jstWeekdayAndMinutes(now);
  return isSuppressedAtMinutes(config, weekday, minutes);
}

/* ------------------------------------------------------------------ *
 *  入力検証（Server Action 用）
 *
 *  UI（AdSuppressionManager）から来た enabled / ranges / weekdays を検証・正規化する。1 項目でも不正なら
 *  全体を拒否（部分保存しない）。quiet-hours-core.validateQuietHours と同じ「HH:MM・start<end・重なり拒否」
 *  規律を踏襲する（機能自己完結のため関数は複製）。
 * ------------------------------------------------------------------ */

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 授業時間（広告停止）設定の入力を検証・正規化する。
 * - `enabled` は boolean（それ以外は不正）。
 * - 各 range は "HH:MM" 24h で `start < end`（同日内・日跨ぎ不可）。件数は 0..MAX。start 昇順で重なりを拒否。
 * - `weekdays` は 0..6 の整数・重複なし（空 = 全曜日オフ＝実質停止なし、を許容）。
 */
export function validateAdSuppression(
  rawEnabled: unknown,
  rawRanges: unknown,
  rawWeekdays: unknown,
): Validated<AdSuppressionConfig> {
  if (typeof rawEnabled !== "boolean") {
    return { ok: false, message: "有効/無効の指定が不正です。" };
  }
  if (!Array.isArray(rawRanges)) {
    return { ok: false, message: "時間帯の指定が不正です。" };
  }
  if (rawRanges.length > MAX_AD_SUPPRESSION_RANGES) {
    return { ok: false, message: `時間帯は ${MAX_AD_SUPPRESSION_RANGES} 件までです。` };
  }

  const parsed: { start: string; end: string; startMin: number; endMin: number }[] = [];
  for (const item of rawRanges) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: "各時間帯は開始・終了時刻を持つ必要があります。" };
    }
    const rec = item as Record<string, unknown>;
    const startMin = toMinutes(rec.start);
    const endMin = toMinutes(rec.end);
    if (startMin === null || endMin === null) {
      return { ok: false, message: "時刻は HH:MM（24 時間表記）で入力してください。" };
    }
    if (startMin >= endMin) {
      return { ok: false, message: "開始時刻は終了時刻より前にしてください（日跨ぎは不可）。" };
    }
    parsed.push({
      start: (rec.start as string).trim(),
      end: (rec.end as string).trim(),
      startMin,
      endMin,
    });
  }
  parsed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let prevEnd = -1;
  for (const range of parsed) {
    if (range.startMin < prevEnd) {
      return { ok: false, message: "時間帯が重なっています。重ならないように設定してください。" };
    }
    prevEnd = range.endMin;
  }

  if (!Array.isArray(rawWeekdays)) {
    return { ok: false, message: "対象曜日の指定が不正です。" };
  }
  const seen = new Set<number>();
  for (const d of rawWeekdays) {
    const n = typeof d === "string" ? Number(d) : d;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 6) {
      return { ok: false, message: "対象曜日の指定が不正です。" };
    }
    seen.add(n);
  }

  return {
    ok: true,
    value: {
      enabled: rawEnabled,
      ranges: parsed.map((p) => ({ start: p.start, end: p.end })),
      weekdays: [...seen].sort((a, b) => a - b),
    },
  };
}
