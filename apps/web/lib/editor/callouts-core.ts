import type { StudentCalloutInput } from "@kimiterrace/db";
import type { Validated } from "./schedule-core";

/**
 * パターン2「生徒呼び出し」編集の純粋検証ロジック・型・定数（postgres / 認可に依存しない）。
 *
 * 検証は `"use server"` から分離（schedule-core / visitors-core と同じ構成）。正規化結果は DB 書込入力
 * `StudentCalloutInput`（@kimiterrace/db、空欄は null）に合わせる（ルール3）。
 *
 * **生徒実名（ADR-034）**: `studentName` は教室サイネージにフルネーム表示される。境界（classToken 端末・RLS
 * 自校・Vertex 非送信・職員 curate）は ADR-034 / student-callouts schema を参照。生徒以外の機微情報は入れない。
 */

const MAX_ITEMS = 50;
const NAME_MAX = 100;
const LOCATION_MAX = 100;
const REASON_MAX = 200;
/** 呼び出し/予定時刻 "HH:MM"（00:00〜23:59）。schema の varchar(5) と整合。 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** trim 後に空なら null、非文字列も null。 */
function norm(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 生徒呼び出し配列を検証・正規化する（1 行でも不正なら全体を拒否）。氏名は必須（1..100）、呼び出し先/用件は
 * 任意（長さ上限）、時刻は任意だが指定時は HH:MM 形式（00:00〜23:59）。空欄は null。
 */
export function validateCalloutItems(raw: unknown): Validated<StudentCalloutInput[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "呼び出しの形式が不正です。" };
  }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, message: `呼び出しは最大 ${MAX_ITEMS} 件までです。` };
  }
  const items: StudentCalloutInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "呼び出しの各行が不正です。" };
    }
    const rec = entry as Record<string, unknown>;

    const studentName = norm(rec.studentName);
    if (!studentName) {
      return { ok: false, message: "生徒の氏名は必須です。" };
    }
    if (studentName.length > NAME_MAX) {
      return { ok: false, message: `氏名は ${NAME_MAX} 文字以内で入力してください。` };
    }

    const location = norm(rec.location);
    if (location && location.length > LOCATION_MAX) {
      return { ok: false, message: `呼び出し先は ${LOCATION_MAX} 文字以内で入力してください。` };
    }
    const reason = norm(rec.reason);
    if (reason && reason.length > REASON_MAX) {
      return { ok: false, message: `用件は ${REASON_MAX} 文字以内で入力してください。` };
    }

    const scheduledTime = norm(rec.scheduledTime);
    if (scheduledTime && !TIME_RE.test(scheduledTime)) {
      return { ok: false, message: "時刻は HH:MM 形式（00:00〜23:59）で入力してください。" };
    }

    items.push({ studentName, location, reason, scheduledTime });
  }
  return { ok: true, value: items };
}
