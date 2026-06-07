import type { Validated } from "./schedule-core";
import { isValidDate } from "./schedule-core";

/**
 * エディタ Notice (連絡) / Assignment (提出物) セクション (#48-I) の純粋ロジック・型・定数。
 *
 * **notices / assignments 要素の正式スキーマをここで確定する** (#48-A では daily_data.notices /
 * daily_data.assignments を opaque JSONB 保持、本スライスが各要素の形を定義)。schedule-core が
 * `ScheduleItem` を確定したのと同じ思想。
 *
 * 要素の形は V1 (`management/src/components/editor/{Notice,Assignment}Section.tsx`) を踏襲:
 * - Notice:    `{ text, isHighlight? }`     (V1 `{ text, is_highlight }`)
 * - Assignment:`{ deadline, subject, task }` (V1 と同名)
 *
 * サイネージ描画 (#48-E1 `SignageBoard.itemLabel`) は要素から代表ラベルを
 * `["title","label","text","subject","name","content"]` の順で防御的に拾う。Notice の `text` と
 * Assignment の `subject` がそれぞれヒットするため、本スキーマは既存描画と整合する。
 *
 * `"use server"` ファイル (notice-assignment-actions.ts) は async export しか持てないため、検証・
 * 型・定数はここに分離する (schedule-core.ts と同じ構成)。`ActionResult` 等は schedule-core から
 * 再利用する (エディタ全体で単一)。
 */

/**
 * 連絡 (お知らせ) の 1 件。`text` は本文 (1..500)、`isHighlight` は重要マーク (既定 false)。
 * `displayDays` は表示日数 (1..{@link NOTICE_MAX_DISPLAY_DAYS}、既定 1=入力日のみ)。入力した日を起点に
 * `displayDays` 日間サイネージに表示する (#243 ②UI-UX「何日後まで表示」)。既定 1 のときは省略。
 * サイネージ (#48-E1) は `text` を代表ラベルとして描画する。
 */
export type NoticeItem = { text: string; isHighlight?: boolean; displayDays?: number };

/**
 * 提出物 (課題) の 1 件。`deadline` は提出期限 (YYYY-MM-DD)、`subject` は科目名 (1..32)、
 * `task` は提出物の内容 (1..200)。サイネージ (#48-E1) は `subject` を代表ラベルとして描画する。
 * 提出物は手動の表示日数を持たず、**入力日〜「期限 + {@link ASSIGNMENT_GRACE_DAYS} 日」まで自動表示**し、
 * 以後はサイネージから自動的に消える (#243、表示判定は signage の effective-daily-data が deadline から行う)。
 */
export type AssignmentItem = { deadline: string; subject: string; task: string };

/** 連絡の表示日数の上限 (入力日を含む日数)。サイネージの遡及読み取り窓の根拠にもなる。 */
export const NOTICE_MAX_DISPLAY_DAYS = 14;

/** 提出物を期限後も表示し続ける猶予日数 (期限 + これ日後まで表示し、以後自動で消える)。 */
export const ASSIGNMENT_GRACE_DAYS = 2;

const MAX_NOTICES = 20;
const NOTICE_TEXT_MAX = 500;

const MAX_ASSIGNMENTS = 30;
const SUBJECT_MAX = 32;
const TASK_MAX = 200;

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
 * 連絡配列を検証・正規化する。1 件でも不正なら全体を拒否 (部分保存しない)。
 * 入力順を保持する (連絡は表示順に意味があるため、schedule の period ソートとは異なる)。
 */
export function validateNoticeItems(raw: unknown): Validated<NoticeItem[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "連絡の形式が不正です。" };
  }
  if (raw.length > MAX_NOTICES) {
    return { ok: false, message: `連絡は最大 ${MAX_NOTICES} 件までです。` };
  }
  const items: NoticeItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "連絡の各件が不正です。" };
    }
    const rec = entry as Record<string, unknown>;
    const text = normalizeString(rec.text, NOTICE_TEXT_MAX);
    if (!text) {
      return { ok: false, message: `連絡の本文は 1〜${NOTICE_TEXT_MAX} 文字で入力してください。` };
    }
    const item: NoticeItem = { text };
    // 真偽以外 (文字列 "true" / undefined 等) は false 扱い。重要マークは明示 true のみ。
    if (rec.isHighlight === true) {
      item.isHighlight = true;
    }
    // 表示日数 (任意)。未指定は既定 1 (入力日のみ)。1..MAX の整数のみ許可し、既定 1 は省略して保存する
    // (JSONB を最小化・後方互換)。
    if (rec.displayDays !== undefined) {
      const d = rec.displayDays;
      if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > NOTICE_MAX_DISPLAY_DAYS) {
        return {
          ok: false,
          message: `表示日数は 1〜${NOTICE_MAX_DISPLAY_DAYS} の整数で指定してください。`,
        };
      }
      if (d > 1) {
        item.displayDays = d;
      }
    }
    items.push(item);
  }
  return { ok: true, value: items };
}

/**
 * 提出物配列を検証・正規化する。1 件でも不正なら全体を拒否 (部分保存しない)。
 * 提出期限 (deadline) の昇順 → 科目名の順で正規化する (保存・描画の決定性)。
 */
export function validateAssignmentItems(raw: unknown): Validated<AssignmentItem[]> {
  if (!Array.isArray(raw)) {
    return { ok: false, message: "提出物の形式が不正です。" };
  }
  if (raw.length > MAX_ASSIGNMENTS) {
    return { ok: false, message: `提出物は最大 ${MAX_ASSIGNMENTS} 件までです。` };
  }
  const items: AssignmentItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: "提出物の各件が不正です。" };
    }
    const rec = entry as Record<string, unknown>;
    if (!isValidDate(rec.deadline)) {
      return { ok: false, message: "提出期限は実在する日付 (YYYY-MM-DD) で入力してください。" };
    }
    const subject = normalizeString(rec.subject, SUBJECT_MAX);
    if (!subject) {
      return { ok: false, message: `科目名は 1〜${SUBJECT_MAX} 文字で入力してください。` };
    }
    const task = normalizeString(rec.task, TASK_MAX);
    if (!task) {
      return { ok: false, message: `提出物の内容は 1〜${TASK_MAX} 文字で入力してください。` };
    }
    items.push({ deadline: rec.deadline, subject, task });
  }
  // 期限の昇順 → 科目名で安定ソート (保存・描画の決定性)。
  items.sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0));
  return { ok: true, value: items };
}
