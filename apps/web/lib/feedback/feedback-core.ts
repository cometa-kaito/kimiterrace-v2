import type { SubmitFeedbackInput } from "@kimiterrace/db";

/**
 * F12 (#48-M): フィードバック投稿入力の検証 (副作用なしの純関数、テスト容易化のため分離)。
 *
 * guide フォームは **非認証** なので、ここが入力の第一防衛線になる。範囲・必須は DB 側でも
 * 二重に守る (CHECK 制約 + SECURITY DEFINER 関数 submit_feedback の RAISE)。本関数は UX 向けの
 * 早期検証 + 型の正規化を担う。`student_episode` は PII を含みうる自由記述だが、保存のみで
 * LLM には渡さない (CLAUDE.md ルール4、packages/db schema/feedback.ts 参照)。
 */

/** 自由記述フィールドの最大長 (DoS / 肥大化防止。V1 に明示上限は無いが妥当な上限を引く)。 */
const MAX_TEXT = 4000;
const MAX_SHORT = 200;

export type FeedbackValidationResult =
  | { ok: true; value: SubmitFeedbackInput }
  | { ok: false; message: string };

/** 1-5 の整数か判定し、整数化して返す (範囲外 / 非数は null)。 */
function parseScore(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const v = Math.round(n);
  if (v < 1 || v > 5) return null;
  return v;
}

/** 任意テキストを trim し、空なら null。長すぎる場合は呼び出し側で弾くため undefined を返さない。 */
function normalizeText(raw: unknown, max: number): { value: string | null; tooLong: boolean } {
  if (raw === null || raw === undefined) return { value: null, tooLong: false };
  const s = String(raw).trim();
  if (s.length === 0) return { value: null, tooLong: false };
  if (s.length > max) return { value: s.slice(0, max), tooLong: true };
  return { value: s, tooLong: false };
}

/**
 * フォーム入力 (FormData 由来の unknown) を検証し、`SubmitFeedbackInput` に正規化する。
 *
 * 必須: studentReaction / teacherUtility (1-5)。schoolName / classroomLabel / studentEpisode /
 * improvement は任意。schoolId は guide からは受け付けない (任意参照で、匿名投稿者は uuid を
 * 知らない。誤った FK を流し込ませない = WITH 何でも受けない)。
 */
export function validateFeedbackInput(raw: {
  schoolName?: unknown;
  classroomLabel?: unknown;
  studentReaction?: unknown;
  teacherUtility?: unknown;
  studentEpisode?: unknown;
  improvement?: unknown;
}): FeedbackValidationResult {
  const studentReaction = parseScore(raw.studentReaction);
  if (studentReaction === null) {
    return { ok: false, message: "生徒の反応・注目度は 1〜5 で選択してください。" };
  }
  const teacherUtility = parseScore(raw.teacherUtility);
  if (teacherUtility === null) {
    return { ok: false, message: "先生の業務負担・利便性は 1〜5 で選択してください。" };
  }

  const schoolName = normalizeText(raw.schoolName, MAX_SHORT);
  const classroomLabel = normalizeText(raw.classroomLabel, MAX_SHORT);
  const studentEpisode = normalizeText(raw.studentEpisode, MAX_TEXT);
  const improvement = normalizeText(raw.improvement, MAX_TEXT);
  if (
    schoolName.tooLong ||
    classroomLabel.tooLong ||
    studentEpisode.tooLong ||
    improvement.tooLong
  ) {
    return { ok: false, message: "入力が長すぎます。文字数を減らしてください。" };
  }

  return {
    ok: true,
    value: {
      schoolName: schoolName.value,
      // guide からは schoolId を受け付けない (任意参照。null 固定)。
      schoolId: null,
      classroomLabel: classroomLabel.value,
      studentReaction,
      teacherUtility,
      studentEpisode: studentEpisode.value,
      improvement: improvement.value,
    },
  };
}
