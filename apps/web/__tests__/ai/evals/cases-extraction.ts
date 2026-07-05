import type { ExtractionKind } from "@kimiterrace/ai";
import type { ExtractionExpectation } from "./score";

/**
 * F03 構造化抽出（音声/ファイル → schedule/announcement/summary/tag）の **ゴールデン評価セット**。
 *
 * F03 は単発・基準日コンテキスト無しのため、入力に明示された事実の抽出忠実性のみを見る
 * （相対日付の解決は評価しない）。氏名・電話・メールは入れない（ルール4）。
 */

export type ExtractionEvalCase = {
  id: string;
  kind: ExtractionKind;
  input: string;
  expected: ExtractionExpectation;
};

export const EXTRACTION_EVAL_CASES: readonly ExtractionEvalCase[] = [
  {
    id: "f03-schedule-basic",
    kind: "schedule",
    input:
      "明日の時間割です。1時間目は国語、2時間目は算数、3時間目は体育、4時間目は音楽です。体育は校庭で行います。",
    expected: {
      scheduleEntries: [
        { period: 1, subject: ["国語"] },
        { period: 2, subject: ["算数"] },
        { period: 3, subject: ["体育"] },
        { period: 4, subject: ["音楽"] },
      ],
      minConfidence: 0.5,
    },
  },
  {
    id: "f03-schedule-messy-transcript",
    kind: "schedule",
    input:
      "えーと明日ですが、1限が数学で、そのあと2限は移動教室で理科室に行って理科です。3限は英語だったんですが変更になって美術です。よろしくお願いします。",
    expected: {
      scheduleEntries: [
        { period: 1, subject: ["数学"] },
        { period: 2, subject: ["理科"] },
        { period: 3, subject: ["美術"] },
      ],
      minConfidence: 0.5,
    },
  },
  {
    id: "f03-announcement-pta",
    kind: "announcement",
    input:
      "保護者会のお知らせ。7月17日の14時から体育館で保護者会を開催します。上履きをご持参ください。出欠票は7月10日までに担任へ提出してください。",
    expected: {
      titleKeywords: [["保護者会"]],
      bodyKeywords: [["体育館"], ["上履き"]],
      minConfidence: 0.5,
    },
  },
  {
    id: "f03-summary-field-trip",
    kind: "summary",
    input:
      "校外学習のしおりについて。7月22日に科学館へ校外学習に行きます。集合は8時30分に昇降口前、持ち物は弁当・水筒・雨具・筆記用具です。班行動を基本とし、館内では走らないこと。帰着は15時30分の予定です。当日欠席する場合は8時までに学校へ連絡してください。",
    expected: {
      summaryKeywords: [["校外学習", "科学館"]],
      minConfidence: 0.5,
    },
  },
  {
    id: "f03-tag-sports-day",
    kind: "tag",
    input:
      "体育祭の練習日程について。今週は全学年で綱引きとリレーの練習を行います。熱中症対策として水筒を必ず持参してください。",
    expected: {
      tagsAny: [["体育祭", "運動会", "スポーツ", "行事"]],
      minConfidence: 0.5,
    },
  },
];
