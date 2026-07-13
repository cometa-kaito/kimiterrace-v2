/**
 * サイネージ「授業時間中の広告配信停止」の **型・純ロジック（単一ソース）**。
 *
 * システム管理者が学校ごとに **時間割バリエーション**（通常時間割・短縮時間割 …）を複数登録し、それらを
 * **年間**（曜日ごとの既定 ＋ 特定日の上書き）で割り当てる。割り当てられた時間帯はサイネージ盤面の広告枠
 * だけを空にする（時間割・連絡・提出物など他ブロックは通常どおり出す）。実機端末は既存の 10 秒ポーリング
 * で追従するので、端末（APK）改修も migration も不要。
 *
 * ## モデル（v2＝バリエーション + 年間割り当て）
 * - `variations`: 名前つき時間割（`{ key, name, ranges:[{start,end}] }`）。`ranges` が「広告を止める時間帯」。
 * - `weekdayMap`: 曜日（0=日..6=土）→ バリエーション `key`（または {@link NONE_VARIATION_KEY}=「広告を止めない」）。
 *   キーが無い曜日は非対象（＝止めない）。
 * - `overrides`: 特定日（`"YYYY-MM-DD"`）→ バリエーション `key`（または NONE）。**weekdayMap より優先**。
 * - 「広告を止めない日」（定期考査・振替休業・行事等で終日広告を出したい日）は NONE を割り当てて表す。
 *
 * ## 保存先（migration 不要・display_settings 相乗り）
 * 学校スコープ `school_configs`（scope='school', kind='display_settings'）の `value.adSuppression` に持たせる
 * （黒画面トグル {@link ./blackout} と同方針。新 `config_kind` enum を足さない＝migration ゼロ）。同じ行の
 * `signageDesign` / `assignmentDeadlineFormat` / `editorDayCutover` とは別キーなので衝突しない。
 *
 * ## 後方互換（v1 単一時間帯からの移行）
 * 旧形式 `{ enabled, ranges, weekdays }`（単一時間割）は {@link parseAdSuppression} が **1 つの「通常時間割」
 * バリエーション**へ透過的に移行する（`weekdays` → weekdayMap への割り当て）。データ移行スクリプトは不要。
 *
 * ## client-safe（drizzle / postgres を import しない）
 * 純ロジックだけを持ち、設定フォーム（"use client" な `AdSuppressionManager`）とサイネージ配信層（server の
 * `signage-display.ts`）・Server Action の**両方**から安全に import できる。DB 読み取りは呼び出し側が取得済みの
 * `display_settings` value を {@link parseAdSuppression} に渡す（追加 round-trip なし）。
 *
 * ## fail-soft の向き（広告は「出る」側に倒す）
 * 設定の読み取り失敗・壊れた値・enabled=false・割り当て無し・NONE・存在しない key 参照はすべて「停止しない
 * （＝広告を出す）」に倒す。事故で広告が全断する（商流の損失）より、事故で広告が出続ける方が安全側という判断。
 */

/** `display_settings` value に相乗りする本機能のキー。 */
export const AD_SUPPRESSION_KEY = "adSuppression" as const;

/** 「広告を止めない」を表す予約 key（weekdayMap / overrides の値に使う。実バリエーションの key に使えない）。 */
export const NONE_VARIATION_KEY = "__none__" as const;

/** 1 バリエーションあたりの時間帯上限（1 校の 1 日のコマ数は十数で十分）。 */
export const MAX_AD_SUPPRESSION_RANGES = 24;

/** バリエーション数の上限（通常/短縮/午前授業/考査…十数種で十分）。 */
export const MAX_AD_SUPPRESSION_VARIATIONS = 16;

/** 特定日上書きの上限（年間の例外日。1 年ぶんを十分に収める）。 */
export const MAX_AD_SUPPRESSION_OVERRIDES = 500;

/** バリエーション名の最大長。 */
export const AD_SUPPRESSION_NAME_MAX = 40;

/** 既定の対象曜日（月〜金）。旧形式移行・初期値のヒントに使う（v1 の授業日 = 平日と一貫）。 */
export const DEFAULT_AD_SUPPRESSION_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** "HH:MM" 24 時間表記（00:00〜23:59）。 */
const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
/** "YYYY-MM-DD"（暦日として実在するかは別途 round-trip で検証）。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** バリエーション key の最大長（暴走入力抑止）。 */
const KEY_MAX = 64;

/** 検証済みの 1 時間帯（同日内・start < end）。DB / 判定へそのまま渡せる正規化済みの値。 */
export type AdSuppressionRange = { start: string; end: string };

/** 名前つき時間割バリエーション（1 種の時程表）。`ranges` が広告を止める時間帯。 */
export type AdSuppressionVariation = {
  /** 安定 id（weekdayMap / overrides から参照）。UI が生成し、編集を跨いで不変に保つ。 */
  key: string;
  /** 表示名（例: "通常時間割" / "短縮時間割"）。 */
  name: string;
  /** 広告を止める時間帯（各 `{ start, end }` は "HH:MM"・同日内）。空なら実質「止めない」。 */
  ranges: AdSuppressionRange[];
};

/** 授業時間（広告停止）設定の本体。`school_configs.value.adSuppression` に格納する形。 */
export type AdSuppressionConfig = {
  /** 機能全体の有効/無効。false なら割り当てがあっても停止しない（＝常に広告を出す）。 */
  enabled: boolean;
  /** 時間割バリエーション一覧。 */
  variations: AdSuppressionVariation[];
  /** 曜日（0=日..6=土）→ バリエーション key or {@link NONE_VARIATION_KEY}。キー無しの曜日は非対象。 */
  weekdayMap: Record<number, string>;
  /** 特定日（"YYYY-MM-DD"）→ バリエーション key or NONE。weekdayMap より優先。 */
  overrides: Record<string, string>;
};

/** 空（＝一切停止しない）設定。読み取り失敗・壊れた値はこれに倒す（fail-soft）。 */
function emptyConfig(): AdSuppressionConfig {
  return { enabled: false, variations: [], weekdayMap: {}, overrides: {} };
}

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

/** "YYYY-MM-DD" が実在暦日か（regex ＋ UTC round-trip で 2 月 30 日等を弾く）。 */
export function isValidDateStr(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === (m as number) - 1 && dt.getUTCDate() === d
  );
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

/** `variations`（unknown JSONB）を防御的に復元する。key/name が非空文字列の要素だけ残す。 */
function readVariations(value: unknown): AdSuppressionVariation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: AdSuppressionVariation[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === "string" ? rec.key.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    // key が空・重複・予約語（NONE）は無効として落とす（参照整合を壊さない）。
    if (!key || key === NONE_VARIATION_KEY || seen.has(key) || name === "") {
      continue;
    }
    seen.add(key);
    out.push({ key, name, ranges: readRanges(rec.ranges) });
  }
  return out;
}

/** 曜日→key マップ（unknown JSONB）を防御的に復元する。曜日 0..6・値が非空文字列の要素だけ残す。 */
function readWeekdayMap(value: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const day = Number(k);
    if (Number.isInteger(day) && day >= 0 && day <= 6 && typeof v === "string" && v.trim() !== "") {
      out[day] = v.trim();
    }
  }
  return out;
}

/** 特定日→key マップ（unknown JSONB）を防御的に復元する。実在日付・値が非空文字列の要素だけ残す。 */
function readOverrides(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isValidDateStr(k) && typeof v === "string" && v.trim() !== "") {
      out[k] = v.trim();
    }
  }
  return out;
}

/**
 * 学校スコープ `display_settings` の value（opaque JSONB）から授業時間（広告停止）設定を **防御的に**取り出す。
 * v2 形式（variations + weekdayMap + overrides）を優先し、無ければ **v1 形式（ranges + weekdays）を 1 つの
 * 「通常時間割」バリエーションへ移行**する。壊れた値・キー欠落はすべて空設定（＝停止しない）に倒す。
 */
export function parseAdSuppression(configValue: unknown): AdSuppressionConfig {
  if (!configValue || typeof configValue !== "object" || Array.isArray(configValue)) {
    return emptyConfig();
  }
  const raw = (configValue as Record<string, unknown>)[AD_SUPPRESSION_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyConfig();
  }
  const rec = raw as Record<string, unknown>;
  const enabled = rec.enabled === true;

  // v2 形式（variations あり）。
  if (Array.isArray(rec.variations)) {
    const variations = readVariations(rec.variations);
    const keys = new Set(variations.map((v) => v.key));
    // 参照整合: 実在しない key（NONE 以外）を指す割り当ては落とす（fail-soft、幽霊参照で停止しない）。
    const validRef = (k: string) => k === NONE_VARIATION_KEY || keys.has(k);
    const weekdayMap: Record<number, string> = {};
    for (const [d, k] of Object.entries(readWeekdayMap(rec.weekdayMap))) {
      if (validRef(k)) {
        weekdayMap[Number(d)] = k;
      }
    }
    const overrides: Record<string, string> = {};
    for (const [date, k] of Object.entries(readOverrides(rec.overrides))) {
      if (validRef(k)) {
        overrides[date] = k;
      }
    }
    return { enabled, variations, weekdayMap, overrides };
  }

  // v1 形式（ranges + weekdays）→ 1 バリエーション「通常時間割」へ移行。
  if (Array.isArray(rec.ranges)) {
    const ranges = readRanges(rec.ranges);
    const legacyKey = "default";
    const weekdays = Array.isArray(rec.weekdays)
      ? rec.weekdays.filter(
          (d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6,
        )
      : [];
    const weekdayMap: Record<number, string> = {};
    for (const d of weekdays) {
      weekdayMap[d] = legacyKey;
    }
    return {
      enabled,
      variations: ranges.length > 0 ? [{ key: legacyKey, name: "通常時間割", ranges }] : [],
      weekdayMap,
      overrides: {},
    };
  }

  return { enabled, variations: [], weekdayMap: {}, overrides: {} };
}

/**
 * 指定日（JST 暦日 `dateStr` / 曜日 `weekday`）に適用される時間割の `ranges` を解決する（純関数）。
 * 優先順位は **特定日上書き > 曜日既定**。割り当て無し・NONE・存在しない key 参照はすべて `null`（＝停止しない）。
 */
export function resolveVariationRanges(
  config: AdSuppressionConfig,
  dateStr: string,
  weekday: number,
): AdSuppressionRange[] | null {
  const key = config.overrides[dateStr] ?? config.weekdayMap[weekday];
  if (!key || key === NONE_VARIATION_KEY) {
    return null;
  }
  const variation = config.variations.find((v) => v.key === key);
  return variation ? variation.ranges : null;
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
 * `now`（絶対時刻）を **JST の暦日 "YYYY-MM-DD" / 曜日（0=日..6=土）/ 0 時からの分**に変換する
 * （端末/サーバ TZ 非依存）。`default-date.ts` の `jstMinutes` と同じ Intl.DateTimeFormat(Asia/Tokyo, h23) 作法。
 */
export function jstDateParts(now: Date): { date: string; weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    date: `${year}-${month}-${day}`,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? -1,
    minutes: hour * 60 + minute,
  };
}

/**
 * JST の暦日・曜日・分から「いま広告を停止すべきか」を判定する純関数（テスト用に時刻依存を切り離した本体）。
 * enabled でない / 割り当て無し / NONE は停止しない。適用 range は `[start, end)`（終了時刻ちょうどは停止しない
 * ＝授業終了で広告が戻る）。
 */
export function isSuppressedAtParts(
  config: AdSuppressionConfig,
  dateStr: string,
  weekday: number,
  minutes: number,
): boolean {
  if (!config.enabled) {
    return false;
  }
  const ranges = resolveVariationRanges(config, dateStr, weekday);
  if (!ranges || ranges.length === 0) {
    return false;
  }
  return ranges.some((r) => {
    const start = toMinutes(r.start);
    const end = toMinutes(r.end);
    return start !== null && end !== null && minutes >= start && minutes < end;
  });
}

/**
 * `now`（絶対時刻）時点で当校のサイネージ広告を停止すべきか。{@link jstDateParts} で JST に落とし
 * {@link isSuppressedAtParts} に委譲する。サイネージ配信層（live 経路のみ）から呼ぶ。
 */
export function isAdSuppressedAt(config: AdSuppressionConfig, now: Date): boolean {
  if (!config.enabled) {
    return false;
  }
  const { date, weekday, minutes } = jstDateParts(now);
  return isSuppressedAtParts(config, date, weekday, minutes);
}

/* ------------------------------------------------------------------ *
 *  入力検証（Server Action 用）
 *
 *  UI（AdSuppressionManager）から来た enabled / variations / weekdayMap / overrides を検証・正規化する。
 *  1 項目でも不正なら全体を拒否（部分保存しない）。時間帯は quiet-hours-core.validateQuietHours と同じ
 *  「HH:MM・start<end・重なり拒否」規律。
 * ------------------------------------------------------------------ */

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/** 1 バリエーションの ranges を検証・正規化する（HH:MM・start<end・重なり拒否・件数上限）。 */
function validateRanges(raw: unknown): Validated<AdSuppressionRange[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "時間帯の指定が不正です。" };
  }
  if (raw.length > MAX_AD_SUPPRESSION_RANGES) {
    return { ok: false, message: `時間帯は ${MAX_AD_SUPPRESSION_RANGES} 件までです。` };
  }
  const parsed: { start: string; end: string; startMin: number; endMin: number }[] = [];
  for (const item of raw) {
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
  return { ok: true, value: parsed.map((p) => ({ start: p.start, end: p.end })) };
}

/**
 * 授業時間（広告停止）設定の入力を検証・正規化する。
 * - `enabled` は boolean。
 * - `variations`: 0..MAX。各 `{ key, name, ranges }` は key 非空・一意（NONE 予約語不可）、name 非空、ranges 妥当。
 * - `weekdayMap`: キー 0..6、値は既存 key or NONE。
 * - `overrides`: キーは実在日付（≤MAX）、値は既存 key or NONE。
 */
export function validateAdSuppression(
  rawEnabled: unknown,
  rawVariations: unknown,
  rawWeekdayMap: unknown,
  rawOverrides: unknown,
): Validated<AdSuppressionConfig> {
  if (typeof rawEnabled !== "boolean") {
    return { ok: false, message: "有効/無効の指定が不正です。" };
  }
  if (!Array.isArray(rawVariations)) {
    return { ok: false, message: "時間割バリエーションの指定が不正です。" };
  }
  if (rawVariations.length > MAX_AD_SUPPRESSION_VARIATIONS) {
    return { ok: false, message: `時間割は ${MAX_AD_SUPPRESSION_VARIATIONS} 種類までです。` };
  }

  const variations: AdSuppressionVariation[] = [];
  const keys = new Set<string>();
  for (const item of rawVariations) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: "時間割バリエーションの形式が不正です。" };
    }
    const rec = item as Record<string, unknown>;
    const key = typeof rec.key === "string" ? rec.key.trim() : "";
    if (!key || key.length > KEY_MAX || key === NONE_VARIATION_KEY) {
      return { ok: false, message: "時間割の内部キーが不正です。" };
    }
    if (keys.has(key)) {
      return { ok: false, message: "時間割の内部キーが重複しています。" };
    }
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) {
      return { ok: false, message: "時間割の名前を入力してください。" };
    }
    if (name.length > AD_SUPPRESSION_NAME_MAX) {
      return { ok: false, message: `時間割の名前は ${AD_SUPPRESSION_NAME_MAX} 文字までです。` };
    }
    const ranges = validateRanges(rec.ranges);
    if (!ranges.ok) {
      return { ok: false, message: `「${name}」の${ranges.message}` };
    }
    keys.add(key);
    variations.push({ key, name, ranges: ranges.value });
  }

  const validRef = (k: string) => k === NONE_VARIATION_KEY || keys.has(k);

  if (!rawWeekdayMap || typeof rawWeekdayMap !== "object" || Array.isArray(rawWeekdayMap)) {
    return { ok: false, message: "曜日ごとの割り当てが不正です。" };
  }
  const weekdayMap: Record<number, string> = {};
  for (const [k, v] of Object.entries(rawWeekdayMap as Record<string, unknown>)) {
    const day = Number(k);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, message: "曜日ごとの割り当てが不正です。" };
    }
    if (typeof v !== "string" || !validRef(v)) {
      return { ok: false, message: "曜日に存在しない時間割が割り当てられています。" };
    }
    weekdayMap[day] = v;
  }

  if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
    return { ok: false, message: "特定日の割り当てが不正です。" };
  }
  const overrideEntries = Object.entries(rawOverrides as Record<string, unknown>);
  if (overrideEntries.length > MAX_AD_SUPPRESSION_OVERRIDES) {
    return { ok: false, message: `特定日の指定は ${MAX_AD_SUPPRESSION_OVERRIDES} 件までです。` };
  }
  const overrides: Record<string, string> = {};
  for (const [date, v] of overrideEntries) {
    if (!isValidDateStr(date)) {
      return { ok: false, message: `特定日の日付が不正です（${date}）。` };
    }
    if (typeof v !== "string" || !validRef(v)) {
      return { ok: false, message: "特定日に存在しない時間割が割り当てられています。" };
    }
    overrides[date] = v;
  }

  return { ok: true, value: { enabled: rawEnabled, variations, weekdayMap, overrides } };
}
