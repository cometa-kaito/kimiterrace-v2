import type { AssistantDraft, ChatTurn, DraftSectionKind } from "@/lib/editor/assistant-chat-core";
import type { AssistantExpectation } from "./score";

/**
 * 会話型 AI アシスタント（教員エディタ）の **ゴールデン評価セット**。
 *
 * 基準日は {@link FIXED_NOW_MS}（2026-07-06 月曜 12:00 JST）に固定し、相対日付の解決を決定的に採点する。
 * カテゴリはユーザー症状（内容の間違い / 取りこぼし / 応答の質）に対応:
 * - date: 相対日付の実在日付解決（明日/来週水曜/金曜）
 * - recall: 1 発話に複数項目（取りこぼし＝recall）
 * - edit: 既存下書きの部分編集（触れていない項目の保全）
 * - clarify: 情報不足時に創作せず聞き返す（ADR-017/プロンプト規律）
 * - routing: 時限に乗らない事項の連絡への振り分け
 * - pattern: パターン準拠（許可外セクション）+ ADR-034 手入力誘導
 * - multiday: 複数日まとめ（days）の日付展開と上限
 * - quality: 応答の質（確認促し・重要マーク）
 *
 * ケース追加時の規律: 相対日付は基準日から一意に解決できる表現のみ使う。氏名・電話・メールは
 * 入れない（ルール4・評価でも実 Vertex に PII を送らない）。
 */

/** 基準日: 2026-07-06(月) 12:00 JST。jstDateLabel に渡す epoch ms。 */
export const FIXED_NOW_MS = Date.UTC(2026, 6, 6, 3, 0, 0); // JST = UTC+9

export type AssistantEvalCase = {
  id: string;
  category: "date" | "recall" | "edit" | "clarify" | "routing" | "pattern" | "multiday" | "quality";
  /** 許可セクション（未指定は pattern1 相当の全 3 セクション）。 */
  allowed?: readonly DraftSectionKind[];
  /** AI が作らない手入力セクションのラベル（pattern2 相当・ADR-034）。 */
  manualSectionLabels?: readonly string[];
  /** 会話履歴（末尾が今回の指示）。 */
  messages: readonly ChatTurn[];
  /** 現在の下書き（編集ケース用・省略時は空）。 */
  draft?: AssistantDraft;
  expected: AssistantExpectation;
};

const u = (content: string): ChatTurn => ({ role: "user", content });
const a = (content: string): ChatTurn => ({ role: "assistant", content });

export const ASSISTANT_EVAL_CASES: readonly AssistantEvalCase[] = [
  // ---- date: 相対日付の解決 ----
  {
    id: "date-deadline-tomorrow",
    category: "date",
    messages: [u("数学のワークp20を宿題にして。締切は明日")],
    expected: {
      assignments: [{ deadline: "2026-07-07", subject: ["数学"], taskKeywords: [["ワーク"]] }],
      emptySections: ["schedules", "notices"],
      noDays: true,
    },
  },
  {
    id: "date-deadline-next-wednesday",
    category: "date",
    messages: [u("英語の単語プリントを提出物に。来週の水曜締切で")],
    expected: {
      assignments: [
        { deadline: "2026-07-15", subject: ["英語"], taskKeywords: [["プリント", "単語"]] },
      ],
      emptySections: ["schedules", "notices"],
      noDays: true,
    },
  },
  {
    id: "date-other-day-schedule",
    category: "date",
    messages: [u("金曜の1限を保健に変えて")],
    expected: {
      // 基準日(月)と別の日への指示は当日 top-level でなく days に入るべき（当日盤面への誤反映防止）。
      days: [{ date: "2026-07-10", schedules: [{ period: 1, subject: ["保健"] }] }],
      emptySections: ["schedules", "notices", "assignments"],
    },
  },

  // ---- recall: 取りこぼし ----
  {
    id: "recall-mixed-six-items",
    category: "recall",
    messages: [
      u(
        "今日の時間割は1限国語、2限数学、3限英語、4限理科。連絡は体操服を持ってくること。あと社会のノート提出、締切は今週の金曜",
      ),
    ],
    expected: {
      schedules: [
        { period: 1, subject: ["国語"] },
        { period: 2, subject: ["数学"] },
        { period: 3, subject: ["英語"] },
        { period: 4, subject: ["理科"] },
      ],
      notices: [{ keywords: [["体操服"]] }],
      assignments: [{ deadline: "2026-07-10", subject: ["社会"], taskKeywords: [["ノート"]] }],
      noDays: true,
    },
  },
  {
    id: "recall-five-notices",
    category: "recall",
    messages: [
      u(
        "連絡を5つお願い。明日は集金日。視力検査は保健室で実施。図書室の本の返却期限が近い。廊下は走らない。水筒を忘れずに",
      ),
    ],
    expected: {
      notices: [
        { keywords: [["集金"]] },
        { keywords: [["視力検査"]] },
        { keywords: [["返却", "図書"]] },
        { keywords: [["廊下"]] },
        { keywords: [["水筒"]] },
      ],
      emptySections: ["schedules", "assignments"],
    },
  },

  // ---- edit: 部分編集の忠実性 ----
  {
    id: "edit-swap-one-period",
    category: "edit",
    draft: {
      schedules: [
        { period: 1, subject: "数学" },
        { period: 2, subject: "国語" },
        { period: 3, subject: "体育" },
      ],
      notices: [{ text: "帽子を持ってくる" }],
      assignments: [],
    },
    messages: [u("2限を英語にして")],
    expected: {
      schedules: [
        { period: 1, subject: ["数学"] },
        { period: 2, subject: ["英語"] },
        { period: 3, subject: ["体育"] },
      ],
      notices: [{ keywords: [["帽子"]] }],
      noDays: true,
    },
  },
  {
    id: "edit-remove-second-notice",
    category: "edit",
    draft: {
      schedules: [],
      notices: [
        { text: "集金は明日です" },
        { text: "視力検査があります" },
        { text: "上履きを洗いましょう" },
      ],
      assignments: [],
    },
    messages: [u("2つ目の連絡を消して")],
    expected: {
      notices: [{ keywords: [["集金"]] }, { keywords: [["上履き"]] }],
      emptySections: ["schedules", "assignments"],
      noDays: true,
    },
  },
  {
    id: "edit-deadline-only",
    category: "edit",
    draft: {
      schedules: [],
      notices: [],
      assignments: [{ deadline: "2026-07-08", subject: "数学", task: "ドリルp10" }],
    },
    messages: [u("数学の締切を金曜に延ばして")],
    expected: {
      assignments: [{ deadline: "2026-07-10", subject: ["数学"], taskKeywords: [["ドリル"]] }],
      emptySections: ["schedules", "notices"],
      noDays: true,
    },
  },

  // ---- clarify: 創作せず聞き返す ----
  {
    id: "clarify-missing-deadline",
    category: "clarify",
    messages: [u("理科のレポートを提出物に入れて")],
    expected: {
      emptySections: ["schedules", "notices", "assignments"],
      noDays: true,
      replyIncludesAny: [
        ["期限", "いつ", "締切", "締め切り"],
        ["？", "?"],
      ],
    },
  },
  {
    id: "clarify-empty-request",
    category: "clarify",
    messages: [u("時間割を入れておいて")],
    expected: {
      emptySections: ["schedules", "notices", "assignments"],
      noDays: true,
      replyIncludesAny: [["？", "?"]],
    },
  },
  {
    id: "clarify-multiturn-deadline-answer",
    category: "clarify",
    messages: [
      u("数学の計算プリント3枚を宿題にして"),
      a("数学の宿題ですね。提出期限はいつにしますか？"),
      u("来週の月曜まで"),
    ],
    expected: {
      assignments: [{ deadline: "2026-07-13", subject: ["数学"], taskKeywords: [["プリント"]] }],
      emptySections: ["schedules", "notices"],
      noDays: true,
    },
  },

  // ---- routing: 時限に乗らない事項 ----
  {
    id: "routing-morning-assembly",
    category: "routing",
    messages: [u("1限は数学。それと朝の会で賞状を渡すので、そのことも入れておいて")],
    expected: {
      schedules: [{ period: 1, subject: ["数学"] }],
      notices: [{ keywords: [["賞状", "表彰"]] }],
      emptySections: ["assignments"],
      noDays: true,
    },
  },
  {
    id: "routing-afterschool-meeting",
    category: "routing",
    messages: [u("放課後に三者面談があります。掲示しておいて")],
    expected: {
      notices: [{ keywords: [["三者面談"]] }],
      emptySections: ["schedules", "assignments"],
      noDays: true,
    },
  },

  // ---- pattern: 許可セクション準拠 + ADR-034 ----
  {
    id: "pattern2-disallowed-notice",
    category: "pattern",
    allowed: ["schedules"],
    manualSectionLabels: ["生徒呼び出し", "来校者一覧"],
    messages: [u("絵の具セットを持ってくるよう連絡に入れて")],
    expected: {
      emptySections: ["schedules", "notices", "assignments"],
      noDays: true,
    },
  },
  {
    id: "pattern2-visitor-manual-guidance",
    category: "pattern",
    allowed: ["schedules"],
    manualSectionLabels: ["生徒呼び出し", "来校者一覧"],
    messages: [u("来校者一覧に明日のお客様の予定を追加しておいて")],
    expected: {
      emptySections: ["schedules", "notices", "assignments"],
      replyIncludesAny: [["手入力", "フォーム", "画面下"]],
    },
  },

  // ---- multiday: 複数日まとめ ----
  {
    id: "multiday-week-math",
    category: "multiday",
    messages: [u("来週の月曜から金曜まで1限は数学にして。火曜だけ1限を実力テストに")],
    expected: {
      days: [
        { date: "2026-07-13", schedules: [{ period: 1, subject: ["数学"] }] },
        { date: "2026-07-14", schedules: [{ period: 1, subject: ["実力テスト", "テスト"] }] },
        { date: "2026-07-15", schedules: [{ period: 1, subject: ["数学"] }] },
        { date: "2026-07-16", schedules: [{ period: 1, subject: ["数学"] }] },
        { date: "2026-07-17", schedules: [{ period: 1, subject: ["数学"] }] },
      ],
      emptySections: ["schedules", "notices", "assignments"],
    },
  },
  {
    id: "multiday-tomorrow-and-day-after",
    category: "multiday",
    messages: [u("明日と明後日、水筒を持ってくるよう連絡して")],
    expected: {
      days: [
        { date: "2026-07-07", notices: [{ keywords: [["水筒"]] }] },
        { date: "2026-07-08", notices: [{ keywords: [["水筒"]] }] },
      ],
      emptySections: ["schedules", "notices", "assignments"],
    },
  },
  {
    id: "multiday-over-limit-ask-split",
    category: "multiday",
    messages: [u("今日から1ヶ月間、毎日1限に自習を入れて")],
    expected: {
      // 7 日上限超は days に入れず「分けましょうか」と聞き返す（プロンプト規定）。
      emptySections: ["schedules", "notices", "assignments"],
      noDays: true,
      replyIncludesAny: [["分け", "何回か", "7日", "1週間"]],
    },
  },

  // ---- quality: 応答の質 ----
  {
    id: "quality-confirm-prompt",
    category: "quality",
    messages: [u("1限を音楽にして")],
    expected: {
      schedules: [{ period: 1, subject: ["音楽"] }],
      emptySections: ["notices", "assignments"],
      noDays: true,
      replyIncludesAny: [["反映", "いいですか", "よろしい"]],
    },
  },
  {
    id: "quality-highlight-notice",
    category: "quality",
    messages: [u("熱中症に注意して、こまめに水分補給するよう連絡。重要マークをつけて")],
    expected: {
      notices: [{ keywords: [["水分"]], isHighlight: true }],
      emptySections: ["schedules", "assignments"],
      noDays: true,
    },
  },
];
