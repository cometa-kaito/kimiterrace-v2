import type { ClassVisitorInput } from "@kimiterrace/db";
import type { Validated } from "./schedule-core";

/**
 * パターン2「来校者一覧」編集の純粋検証ロジック・型・定数（postgres / 認可に依存しない）。
 *
 * `"use server"` ファイル（visitors-actions.ts）は async export しか持てないため検証はここに分離する
 * （schedule-core / config-edit-core と同じ構成）。client の `VisitorsEditor` もここから型・検証を import
 * できる。正規化結果は DB 書込入力 `ClassVisitorInput`（@kimiterrace/db、空欄は null）に合わせる（ルール3:
 * 書込型を単一ソース化し手書きで二重定義しない）。
 *
 * **個人情報**: `visitorName` は教室サイネージに表示される（ユーザー確定 2026-06-10、class-visitors schema の
 * 「個人情報について」参照）。生徒個人 PII は入れない（来校者は外部の成人・所属/用件は業務情報）。
 */

const MAX_ITEMS = 50;
const NAME_MAX = 100;
const AFFILIATION_MAX = 100;
const PURPOSE_MAX = 200;
const HOST_MAX = 100;
const NOTE_MAX = 1000;
/** 来校/予定時刻 "HH:MM"（00:00〜23:59）。schema の varchar(5) と整合。 */
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
 * 来校者配列を検証・正規化する（1 行でも不正なら全体を拒否＝部分保存しない）。氏名は必須（1..100）、
 * 所属/用件/対応者/備考は任意（長さ上限）、時刻は任意だが指定時は HH:MM 形式（00:00〜23:59）。空欄は null。
 */
export function validateVisitorItems(raw: unknown): Validated<ClassVisitorInput[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "来校者の形式が不正です。" };
  }
  if (raw.length > MAX_ITEMS) {
    return { ok: false, message: `来校者は最大 ${MAX_ITEMS} 名までです。` };
  }
  const items: ClassVisitorInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "来校者の各行が不正です。" };
    }
    const rec = entry as Record<string, unknown>;

    const visitorName = norm(rec.visitorName);
    if (!visitorName) {
      return { ok: false, message: "来校者の氏名は必須です。" };
    }
    if (visitorName.length > NAME_MAX) {
      return { ok: false, message: `氏名は ${NAME_MAX} 文字以内で入力してください。` };
    }

    const affiliation = norm(rec.affiliation);
    if (affiliation && affiliation.length > AFFILIATION_MAX) {
      return { ok: false, message: `所属は ${AFFILIATION_MAX} 文字以内で入力してください。` };
    }
    const purpose = norm(rec.purpose);
    if (purpose && purpose.length > PURPOSE_MAX) {
      return { ok: false, message: `用件は ${PURPOSE_MAX} 文字以内で入力してください。` };
    }
    const host = norm(rec.host);
    if (host && host.length > HOST_MAX) {
      return { ok: false, message: `対応者は ${HOST_MAX} 文字以内で入力してください。` };
    }
    const note = norm(rec.note);
    if (note && note.length > NOTE_MAX) {
      return { ok: false, message: `備考は ${NOTE_MAX} 文字以内で入力してください。` };
    }

    const scheduledTime = norm(rec.scheduledTime);
    if (scheduledTime && !TIME_RE.test(scheduledTime)) {
      return { ok: false, message: "時刻は HH:MM 形式（00:00〜23:59）で入力してください。" };
    }

    const item: ClassVisitorInput = {
      visitorName,
      affiliation,
      scheduledTime,
      purpose,
      host,
      note,
    };
    // 重要マーク（★・PR-B §5.2・migration 0037 is_highlight）。明示 true のみ（連絡の isHighlight と同作法）。
    if (rec.isHighlight === true) {
      item.isHighlight = true;
    }
    items.push(item);
  }
  return { ok: true, value: items };
}
