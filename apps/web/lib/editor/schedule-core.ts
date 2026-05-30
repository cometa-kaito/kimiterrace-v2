import type { AuthUser } from "../auth/session";

/**
 * エディタ Schedule セクション (#48-H) の純粋ロジック・型・定数。
 *
 * **schedule 要素の正式スキーマをここで確定する** (#48-A では daily_data.schedules を opaque
 * JSONB 保持、#48-H/#48-I が各セクションの形を定義)。サイネージ描画 (#48-E1) は要素から
 * `subject` 等を拾うため、ここで `subject` を必須にすることで描画と整合する。
 *
 * `"use server"` ファイル (schedule-actions.ts) は async export しか持てないため、検証・型・
 * 定数はここに分離する (school-admin/hub-core.ts と同じ構成、ActionResult も自己完結で定義)。
 */

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

/** スケジュールを編集できるロール。教員と学校管理者 (自校スコープ)。 */
export const EDITOR_ROLES = ["school_admin", "teacher"] as const;

export type EditorActor = { userId: string; schoolId: string };

export function toEditorActor(user: AuthUser): EditorActor | null {
  if (!user.schoolId) {
    return null;
  }
  return { userId: user.uid, schoolId: user.schoolId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** YYYY-MM-DD 形式かつ実在日付か (例: 2026-02-30 は不正)。 */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === (m as number) - 1 && dt.getUTCDate() === d
  );
}

/**
 * 時間割の 1 コマ。`period` は時限 (1..12)、`subject` は科目名 (1..32)、`note` は任意の補足。
 * サイネージ (#48-E1) は `subject` を代表ラベルとして描画する。
 */
export type ScheduleItem = { period: number; subject: string; note?: string };

const MAX_ITEMS = 12;
const SUBJECT_MAX = 32;
const NOTE_MAX = 200;

type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

function normalizeString(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) {
    return null;
  }
  return trimmed;
}

/**
 * 時間割配列を検証・正規化する。1 件でも不正なら全体を拒否 (部分保存しない)。
 * period の重複は許容しない (同じ時限が 2 つあると描画・編集が破綻するため)。
 */
export function validateScheduleItems(raw: unknown): Validated<ScheduleItem[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "時間割の形式が不正です。" };
  }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, message: `時間割は最大 ${MAX_ITEMS} コマまでです。` };
  }
  const seen = new Set<number>();
  const items: ScheduleItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "時間割の各コマが不正です。" };
    }
    const rec = entry as Record<string, unknown>;
    const period = typeof rec.period === "string" ? Number(rec.period) : rec.period;
    if (
      typeof period !== "number" ||
      !Number.isInteger(period) ||
      period < 1 ||
      period > MAX_ITEMS
    ) {
      return { ok: false, message: `時限は 1〜${MAX_ITEMS} の整数で入力してください。` };
    }
    if (seen.has(period)) {
      return { ok: false, message: `時限 ${period} が重複しています。` };
    }
    seen.add(period);
    const subject = normalizeString(rec.subject, SUBJECT_MAX);
    if (!subject) {
      return { ok: false, message: `科目名は 1〜${SUBJECT_MAX} 文字で入力してください。` };
    }
    const item: ScheduleItem = { period, subject };
    if (rec.note !== undefined && rec.note !== null && rec.note !== "") {
      const note = normalizeString(rec.note, NOTE_MAX);
      if (!note) {
        return { ok: false, message: `補足は ${NOTE_MAX} 文字以内で入力してください。` };
      }
      item.note = note;
    }
    items.push(item);
  }
  // 時限の昇順に正規化 (保存・描画の決定性)。
  items.sort((a, b) => a.period - b.period);
  return { ok: true, value: items };
}
