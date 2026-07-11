import {
  CALENDAR_EVENT_LOCATION_MAX,
  CALENDAR_EVENT_SUMMARY_MAX,
  type CalendarImportEvent,
  type FiscalYearWindow,
  MAX_FILE_IMPORT_EVENTS,
  calendarImportEventSchema,
} from "./calendar-import-core";
import { isValidDate } from "./schedule-core";

/**
 * 取込プレビューで教員が編集した行事一覧の**保存前再検証**（ADR-049 PR-C の純コア）。DB / Vertex 非依存。
 *
 * プレビュー（`draftCalendarEventsFromText` の出力）は sanitize 済みだが、教員が行を**編集**できる以上、
 * クライアントから届く配列は信用しない（改変・不正日付・年度窓外・重複が混入しうる）。ここで
 * {@link calendarImportEventSchema}（構造・長さ）+ 実在暦日 + 年度窓 + 重複 + 上限を再強制する。
 *
 * sanitize（取込時）と違い **drop しない**: 保存は教員の明示確定（ADR-049 決定 4）なので、問題行を黙って
 * 落とすと「確認した内容」と「保存された内容」がズレる。全て検証エラー（行番号 + 理由）として返し、
 * 教員がプレビュー上で直してから保存し直す（切り詰め・自動修正もしない。ADR-049 沈黙の切り捨て禁止）。
 */

/** 保存前再検証で見つかった問題。`index` はプレビュー表の行番号（0 始まり。行に紐づかない全体問題は -1）。 */
export interface CalendarImportSaveIssue {
  index: number;
  message: string;
}

/** 保存前再検証の結果。ok 時の events はスキーマ通過済み（空 endDate/location は省略に正規化）。 */
export type CalendarImportSaveValidation =
  | { ok: true; events: CalendarImportEvent[] }
  | { ok: false; issues: CalendarImportSaveIssue[] };

/** Zod のフィールド path → 教員向け文言（スキーマ不適合の行単位メッセージ）。 */
function schemaIssueMessage(field: PropertyKey | undefined): string {
  switch (field) {
    case "summary":
      return `行事名は 1〜${CALENDAR_EVENT_SUMMARY_MAX} 文字で入力してください。`;
    case "startDate":
      return "開始日を YYYY-MM-DD 形式で入力してください。";
    case "endDate":
      return "終了日は YYYY-MM-DD 形式で入力してください（単日の行事は空欄）。";
    case "location":
      return `場所は ${CALENDAR_EVENT_LOCATION_MAX} 文字以内で入力してください（無ければ空欄）。`;
    default:
      return "行の形式が不正です。";
  }
}

/**
 * プレビュー編集後の行事一覧を保存用に再検証する。
 *
 * 1. 配列であること・空でないこと（空の置き換え = 前回取込の全消しは本 UI の意図外・誤操作防止）・
 *    {@link MAX_FILE_IMPORT_EVENTS} 以内であること
 * 2. 各行が {@link calendarImportEventSchema} を通ること（構造・長さ）
 * 3. startDate が実在暦日かつ年度窓内（"2026-02-30" や年度外は AI 取込では drop だが、保存では明示エラー）
 * 4. endDate があるなら実在暦日・開始日以降・年度末以内
 * 5. 同一 (summary, startDate) の重複が無いこと（sanitize の dedupe と同じ境界。後から現れた行を指す）
 *
 * @param rows   クライアント（プレビュー UI）から届いた編集済み行事一覧（信用しない）。
 * @param window 保存時点の年度窓（`fiscalYearWindow`）。
 */
export function validateCalendarImportSave(
  rows: unknown,
  window: FiscalYearWindow,
): CalendarImportSaveValidation {
  if (!Array.isArray(rows)) {
    return { ok: false, issues: [{ index: -1, message: "保存データの形式が不正です。" }] };
  }
  if (rows.length === 0) {
    return {
      ok: false,
      issues: [
        {
          index: -1,
          message: "保存する行事がありません。行事を 1 件以上残すか、取込をやり直してください。",
        },
      ],
    };
  }
  if (rows.length > MAX_FILE_IMPORT_EVENTS) {
    return {
      ok: false,
      issues: [{ index: -1, message: `行事が多すぎます（上限 ${MAX_FILE_IMPORT_EVENTS} 件）。` }],
    };
  }

  const issues: CalendarImportSaveIssue[] = [];
  const events: CalendarImportEvent[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const parsed = calendarImportEventSchema.safeParse(row);
    if (!parsed.success) {
      issues.push({ index, message: schemaIssueMessage(parsed.error.issues[0]?.path[0]) });
      continue;
    }
    const ev = parsed.data;
    if (!isValidDate(ev.startDate)) {
      issues.push({ index, message: "開始日が実在しない日付です。" });
      continue;
    }
    // YYYY-MM-DD はゼロ埋め固定長ゆえ文字列比較 = 日付順序（calendar-import-core と同作法）。
    if (ev.startDate < window.start || ev.startDate > window.end) {
      issues.push({
        index,
        message: `開始日が対象年度（${window.start}〜${window.end}）の外です。`,
      });
      continue;
    }
    if (
      ev.endDate !== undefined &&
      (!isValidDate(ev.endDate) || ev.endDate < ev.startDate || ev.endDate > window.end)
    ) {
      issues.push({
        index,
        message: "終了日は開始日以降・年度内の実在する日付にしてください（単日の行事は空欄）。",
      });
      continue;
    }
    const key = `${ev.startDate} ${ev.summary}`;
    if (seen.has(key)) {
      issues.push({ index, message: "同じ行事名・開始日の行が重複しています。" });
      continue;
    }
    seen.add(key);
    events.push(ev);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, events };
}
