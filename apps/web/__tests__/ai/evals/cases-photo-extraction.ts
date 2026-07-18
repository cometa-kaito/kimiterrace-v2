import type { AssistantExpectation } from "./score";
import type { PhotoFixtureId } from "./photo-fixtures";

/**
 * P1 写真取込（紙のプリント写真 → OCR → 会話型チャット合流 → 盤面下書き）の **ゴールデン評価セット**
 * （設計 D5/D8: docs/design/editor-shipping-and-zero-input-2026-07.md §3.2）。
 *
 * 測るのは「写真 1 枚がどれだけ正しく下書きに落ちるか」の end-to-end:
 * 合成画像（photo-fixtures.ts・PII ゼロ）→ 実 Gemini OCR（createGeminiOcrClient = 本番と同一
 * クライアント）→ buildPhotoImportChatMessage（本番と同一の注入形式・単一ソース）→ 会話型
 * アシスタント → sanitizeDraft → scoreAssistantTurn。
 *
 * 基準日は cases-assistant の FIXED_NOW_MS（2026-07-06 月）に固定。フィクスチャ内の日付は全て
 * 基準日より後・14 日対応表の範囲内で、期待 `days` の日付と 1:1 に対応する
 * （photo-fixtures.test.ts が常時検査）。プリントは「今日以外の日」の告知が本質なので、
 * 全ケースで top-level は空・days への振り分けを期待する。
 */

export type PhotoEvalCase = {
  id: string;
  /** レポート集計のカテゴリ（photo- プレフィクスで既存カテゴリと区別）。 */
  category: "photo-newsletter" | "photo-timetable" | "photo-belongings";
  /** photo-fixtures.ts のフィクスチャ。 */
  fixtureId: PhotoFixtureId;
  expected: AssistantExpectation;
};

export const PHOTO_EVAL_CASES: readonly PhotoEvalCase[] = [
  {
    // 学年通信: 複数日（月/水/金）への振り分け。予定行（時限つき）と連絡行（時限なし）の混在。
    id: "photo-newsletter-next-week",
    category: "photo-newsletter",
    fixtureId: "grade-newsletter",
    expected: {
      days: [
        {
          date: "2026-07-13",
          schedules: [
            { period: 1, subject: ["国語"] },
            { period: 2, subject: ["数学"] },
            { period: 3, subject: ["英語"] },
          ],
        },
        { date: "2026-07-15", notices: [{ keywords: [["体育祭"], ["体操服"]] }] },
        { date: "2026-07-17", notices: [{ keywords: [["三者懇談", "懇談"], ["午前"]] }] },
      ],
      emptySections: ["schedules", "notices", "assignments"],
      replyIncludesAny: [["反映"]],
    },
  },
  {
    // 時間割変更: 明日 1 日の 6 時限を全部拾えるか（recall）+ 別日ゆえ days に入るか。
    id: "photo-timetable-change-tomorrow",
    category: "photo-timetable",
    fixtureId: "timetable-change",
    expected: {
      days: [
        {
          date: "2026-07-07",
          schedules: [
            { period: 1, subject: ["体育"] },
            { period: 2, subject: ["国語"] },
            { period: 3, subject: ["理科"] },
            { period: 4, subject: ["英語"] },
            { period: 5, subject: ["音楽"] },
            { period: 6, subject: ["総合"] },
          ],
          notices: [{ keywords: [["体操服"]] }],
        },
      ],
      emptySections: ["schedules", "notices", "assignments"],
      replyIncludesAny: [["反映"]],
    },
  },
  {
    // 持ち物連絡: 特定日（明後日）の校外学習。system 規則「連絡は 1 文・簡潔」に沿い、
    // 集合案内と持ち物リストが別々の連絡に分かれることを期待する（合体した場合は部分点）。
    id: "photo-belongings-field-trip",
    category: "photo-belongings",
    fixtureId: "belongings-notice",
    expected: {
      days: [
        {
          date: "2026-07-08",
          notices: [
            { keywords: [["校外学習", "科学館"], ["集合"]] },
            { keywords: [["弁当"], ["水筒"], ["雨具"]] },
          ],
        },
      ],
      emptySections: ["schedules", "notices", "assignments"],
      replyIncludesAny: [["反映"]],
    },
  },
];
