// 型は **client-safe な /schema サブパス**からのみ import する。barrel (`@kimiterrace/db`) は
// client.ts 経由で postgres ドライバを引き込み、"use client" なフォームにバンドルされると Turbopack が
// fs/net/tls を解決できず next build が落ちる (quiet-hours-core.ts と同じ #148 の罠)。/schema は型定義のみで
// postgres を含まないため client component / core から安全に使える。
import type { TvSchedule } from "@kimiterrace/db/schema";
import type { AuthUser } from "../auth/session";

/**
 * F15 §4.2 (ADR-022): TV デバイス設定編集の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (config-edit-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (quiet-hours-core.ts / ads-core.ts と同じ構成)。client form もここから
 * 型・検証を import できる（postgres を引き込まない）。
 *
 * **編集可能フィールド（オペレーター編集可能）**: `label` / `signageUrl` / `targetMac` / `webhookUrl` /
 * `scheduleJson` / `monitoringEnabled` / `notes`。これらだけを検証・正規化して DB パッチに渡す。
 * **システム管理列**（`deviceId` / `schoolId` / `version` / `lastSeenAt` / `lastKnownIp` / `lastBootAt` /
 * `appVersion` / `alertState` / `deletedAt` / 監査列 / 教室 FK）は本検証が**受け付けない**（入力に紛れても
 * 黙殺し、DB パッチへ漏らさない）。`version` は query 層が +1（ADR-022）。
 *
 * **型の単一ソース (ルール3)**: `TvSchedule` は `@kimiterrace/db/schema` から import し、手書きで再定義
 * しない。PII を入れない（`label` は設置場所ラベル、ルール4）。
 */

/** Server Action の結果。失敗は throw せず `{ ok:false }` で返し、UI 側でメッセージ表示する。 */
export type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: "invalid" | "forbidden" | "conflict" | "not_found"; message: string };
    };

export type ActionError = Extract<ActionResult<never>, { ok: false }>;

export function invalid(message: string): ActionError {
  return { ok: false, error: { code: "invalid", message } };
}
export function forbidden(message: string): ActionError {
  return { ok: false, error: { code: "forbidden", message } };
}
export function conflict(message: string): ActionError {
  return { ok: false, error: { code: "conflict", message } };
}
export function notFound(message: string): ActionError {
  return { ok: false, error: { code: "not_found", message } };
}

/**
 * TV 設定を編集できるロール。自校の school_admin と学校横断の system_admin。
 * teacher は不可 — 設定変更（サイネージ URL / センサー MAC / スケジュール）は運用権限を要するため、
 * クラス静粛時間編集 (QUIET_HOURS_ROLES) と同一境界に揃える（F15 §4.2 は school_admin によるスケジュール
 * 編集を想定、teacher は閲覧のみ）。閲覧専用の一覧 (`/admin/tv-devices`) は ADMIN_ROLES（teacher 含む）の
 * ままで、書き込みだけをこの集合に絞る（多層防御の role 境界、ルール2）。
 */
export const TV_CONFIG_EDIT_ROLES = ["school_admin", "system_admin"] as const;

/** mutation の実行者。`schoolId` は監査・テナント整合に使う（テナント未選択 system_admin は不可）。 */
export type TvConfigEditActor = { userId: string; schoolId: string };

/**
 * AuthUser を mutation actor に変換する。school に属さない（school_id null = テナント未選択の
 * system_admin）場合は null。呼出側が forbidden に変換する。
 */
export function toTvConfigEditActor(user: AuthUser): TvConfigEditActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "HH:MM" を分換算する範囲だが schedule は hour-of-day 単位（0-23）。 */
const HOUR_MIN = 0;
const HOUR_MAX = 23;

/** 入力上限（暴走入力 / DoS 抑止、DB の varchar 長とも整合）。 */
export const LABEL_MAX = 200;
export const TARGET_MAC_MAX = 64;
/** signage_url / webhook_url は text 列だが実務上の上限を設ける（巨大入力拒否）。 */
export const URL_MAX = 2048;
export const NOTES_MAX = 2000;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/** http(s) の絶対 URL か（相対 / javascript: 等のスキームを弾く）。空文字はクリア扱い（呼出側で判定）。 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** weekday マスク（0=日..6=土）の配列か。重複・範囲外は拒否。 */
function validWeekdays(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  if (value.length > 7) return false;
  const seen = new Set<number>();
  for (const d of value) {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0 || d > 6) return false;
    if (seen.has(d)) return false;
    seen.add(d);
  }
  return true;
}

/** hour-of-day（0-23）の整数か。 */
function validHour(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= HOUR_MIN && value <= HOUR_MAX
  );
}

/**
 * schedule_json の入力を検証・正規化する（TvSchedule の形に収める）。null/undefined は「スケジュール無し」。
 * `enabled` 必須（boolean）。`onHour`/`offHour` は 0-23 の整数（任意）、`weekdays` は 0-6 の重複なし配列（任意）。
 * 余剰キーは落とす（既知フィールドのみ通す）。
 */
export function validateSchedule(raw: unknown): Validated<TvSchedule | null> {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "object") {
    return { ok: false, message: "スケジュールの形式が不正です。" };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.enabled !== "boolean") {
    return { ok: false, message: "スケジュールの enabled は真偽値で指定してください。" };
  }
  const out: TvSchedule = { enabled: rec.enabled };
  if (rec.onHour !== undefined) {
    if (!validHour(rec.onHour)) {
      return { ok: false, message: "表示開始時刻は 0〜23 の整数で指定してください。" };
    }
    out.onHour = rec.onHour;
  }
  if (rec.offHour !== undefined) {
    if (!validHour(rec.offHour)) {
      return { ok: false, message: "表示終了時刻は 0〜23 の整数で指定してください。" };
    }
    out.offHour = rec.offHour;
  }
  if (rec.weekdays !== undefined) {
    if (!validWeekdays(rec.weekdays)) {
      return { ok: false, message: "曜日は 0(日)〜6(土) の重複なし配列で指定してください。" };
    }
    out.weekdays = [...rec.weekdays].sort((a, b) => a - b);
  }
  return { ok: true, value: out };
}

/**
 * 編集可能フィールドのみを取り出して検証・正規化したパッチ（query 層 `TvDeviceConfigPatch` 互換）。
 * 文字列フィールドは trim し、空文字は `null`（クリア）に正規化する。
 */
export type TvConfigEditPatch = {
  label: string | null;
  targetMac: string | null;
  signageUrl: string | null;
  webhookUrl: string | null;
  scheduleJson: TvSchedule | null;
  monitoringEnabled: boolean;
  notes: string | null;
};

export type TvConfigEditInput = {
  label?: unknown;
  targetMac?: unknown;
  signageUrl?: unknown;
  webhookUrl?: unknown;
  schedule?: unknown;
  monitoringEnabled?: unknown;
  notes?: unknown;
};

/** trim 後に空なら null、長さ超過は超過フラグを返す内部ヘルパ。 */
function normStr(value: unknown, max: number): { value: string | null; tooLong: boolean } {
  if (typeof value !== "string") return { value: null, tooLong: false };
  const t = value.trim();
  if (t === "") return { value: null, tooLong: false };
  return { value: t, tooLong: t.length > max };
}

/**
 * 編集フォーム入力を検証・正規化する。**編集可能フィールドのみ**を受け取り、システム管理列は型レベルで
 * 入ってこない（万一余剰キーが来ても本関数は読まないため DB に漏れない）。1 項目でも不正なら全体を拒否。
 */
export function validateTvConfigEdit(raw: TvConfigEditInput): Validated<TvConfigEditPatch> {
  const label = normStr(raw.label, LABEL_MAX);
  if (label.tooLong) {
    return { ok: false, message: `ラベルは ${LABEL_MAX} 文字までです。` };
  }
  const targetMac = normStr(raw.targetMac, TARGET_MAC_MAX);
  if (targetMac.tooLong) {
    return { ok: false, message: `センサー MAC は ${TARGET_MAC_MAX} 文字までです。` };
  }
  const signageUrl = normStr(raw.signageUrl, URL_MAX);
  if (signageUrl.tooLong) {
    return { ok: false, message: `サイネージ URL は ${URL_MAX} 文字までです。` };
  }
  if (signageUrl.value !== null && !isHttpUrl(signageUrl.value)) {
    return { ok: false, message: "サイネージ URL は http(s) の絶対 URL を指定してください。" };
  }
  const webhookUrl = normStr(raw.webhookUrl, URL_MAX);
  if (webhookUrl.tooLong) {
    return { ok: false, message: `Webhook URL は ${URL_MAX} 文字までです。` };
  }
  if (webhookUrl.value !== null && !isHttpUrl(webhookUrl.value)) {
    return { ok: false, message: "Webhook URL は http(s) の絶対 URL を指定してください。" };
  }
  const notes = normStr(raw.notes, NOTES_MAX);
  if (notes.tooLong) {
    return { ok: false, message: `メモは ${NOTES_MAX} 文字までです。` };
  }

  if (raw.monitoringEnabled !== undefined && typeof raw.monitoringEnabled !== "boolean") {
    return { ok: false, message: "死活監視の有効/無効は真偽値で指定してください。" };
  }
  const monitoringEnabled = raw.monitoringEnabled === undefined ? true : raw.monitoringEnabled;

  const schedule = validateSchedule(raw.schedule);
  if (!schedule.ok) {
    return schedule;
  }

  return {
    ok: true,
    value: {
      label: label.value,
      targetMac: targetMac.value,
      signageUrl: signageUrl.value,
      webhookUrl: webhookUrl.value,
      scheduleJson: schedule.value,
      monitoringEnabled,
      notes: notes.value,
    },
  };
}
