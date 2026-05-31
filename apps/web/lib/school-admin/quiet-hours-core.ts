// configKind は **client-safe な /schema サブパス**から import する。barrel (`@kimiterrace/db`) は
// client.ts 経由で postgres ドライバを引き込み、"use client" な QuietHoursManager にバンドルされると
// Turbopack が fs/net/tls を解決できず next build が落ちる (#48-J Reviewer Critical-1 / #148)。
// /schema は enum/テーブル定義のみで postgres を含まないため client component から安全に使える。
import type { configKind } from "@kimiterrace/db/schema";
import type { AuthUser } from "../auth/session";

/**
 * クラス設定「静粛時間 (quiet_hours)」(#48-J-2) の純粋ロジック・型・定数。
 *
 * `"use server"` ファイル (quiet-hours-actions.ts) は async 関数しか export できない Next の制約のため、
 * 検証・型・定数はここに分離する (ads-core.ts / hub-core.ts と同じ構成)。
 *
 * **value 構造の単一ソース (読み取り契約との整合)**: サイネージの実効日次データ
 * (`apps/web/lib/signage/effective-daily-data.ts`) は `daily_data.quiet_hours` を **時間帯要素の配列**
 * として読む (`MergedSection.items`)。`school_configs.value` は JSONB の **オブジェクト** (default `{}`)
 * なので、本機能では時間帯配列をオブジェクトで包んで `{ ranges: [{ start, end }] }` の形で保存する。
 * 各 range の `{ start, end }` は signage が期待する時間帯要素の形 ("HH:MM" 24h 表記) に揃える。
 *
 * **型の単一ソース (ルール3)**: `kind` は `@kimiterrace/db` の `configKind` enum から派生し、
 * 手書きで列挙しない。quiet_hours は PII を含まない (時刻のみ)。
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
 * 静粛時間を編集できるロール。自校の school_admin と学校横断の system_admin。
 * teacher は不可 — V1 のクラス設定画面 (`class-settings`) が school_admin gate である整合に合わせる
 * (広告 ADS_ROLES と同一境界、`docs/STATUS.md` 2026-05-31 の認可設計確認に準拠)。
 */
export const QUIET_HOURS_ROLES = ["school_admin", "system_admin"] as const;

/** 本機能が扱う設定種別 (config_kind enum 由来、単一ソース)。 */
export const QUIET_HOURS_KIND =
  "quiet_hours" as const satisfies (typeof configKind.enumValues)[number];

/** mutation の実行者。`schoolId` は RLS WITH CHECK 充足 + 監査に使う (テナント外は不可)。 */
export type QuietHoursActor = { userId: string; schoolId: string };

/**
 * AuthUser を mutation actor に変換する。school に属さない (school_id null = テナント未選択の
 * system_admin) 場合は null。呼出側が forbidden に変換する。
 */
export function toQuietHoursActor(user: AuthUser): QuietHoursActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "HH:MM" 24 時間表記。00:00〜23:59。 */
const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
/** 暴走入力 (巨大配列) を防ぐ実務上限。1 クラスの静粛時間帯は十数件で十分。 */
const MAX_RANGES = 24;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
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

/** 検証済みの 1 時間帯 (DB / signage へそのまま渡せる正規化済みの値)。 */
export type QuietRange = { start: string; end: string };

/** quiet_hours の value 本体 (school_configs.value に格納するオブジェクト)。 */
export type QuietHoursValue = { ranges: QuietRange[] };

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * 静粛時間の入力 (時間帯配列) を検証・正規化する。
 *
 * - 各 range は `start` / `end` が "HH:MM" 24h で、`start < end` (同日内、日跨ぎ不可)。
 * - range 数は 0..MAX_RANGES。0 件は「静粛時間なし」として許可する (全削除 = 空配列)。
 * - 重なり / 隣接無秩序を避けるため start 昇順に整列し、**重なり (overlap) を検出したら拒否**する。
 * 1 項目でも不正なら全体を拒否 (部分保存しない)。
 */
export function validateQuietHours(raw: unknown): Validated<QuietHoursValue> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "静粛時間の指定が不正です。" };
  }
  if (raw.length > MAX_RANGES) {
    return { ok: false, message: `静粛時間は ${MAX_RANGES} 件までです。` };
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
      return { ok: false, message: "時刻は HH:MM (24 時間表記) で入力してください。" };
    }
    if (startMin >= endMin) {
      return { ok: false, message: "開始時刻は終了時刻より前にしてください (日跨ぎは不可)。" };
    }
    parsed.push({
      start: (rec.start as string).trim(),
      end: (rec.end as string).trim(),
      startMin,
      endMin,
    });
  }

  // start 昇順に整列し、隣接する時間帯の重なりを検出する (重なりは設定ミスとして拒否)。
  parsed.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  let prevEnd = -1;
  for (const range of parsed) {
    if (range.startMin < prevEnd) {
      return { ok: false, message: "時間帯が重なっています。重ならないように設定してください。" };
    }
    prevEnd = range.endMin;
  }

  return {
    ok: true,
    value: { ranges: parsed.map((p) => ({ start: p.start, end: p.end })) },
  };
}

/**
 * 保存済み value (unknown JSONB) を UI 表示用の range 配列に**防御的に**復元する。
 * 不正・未設定は空配列。`getClassConfigValue` の戻り値をそのまま渡してよい。
 */
export function readQuietRanges(value: unknown): QuietRange[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const ranges = (value as Record<string, unknown>).ranges;
  if (!Array.isArray(ranges)) {
    return [];
  }
  const out: QuietRange[] = [];
  for (const item of ranges) {
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
