import { describe, expect, it } from "vitest";
import type { AssistantDraft, ChatTurn } from "../../lib/editor/assistant-chat-core";
import {
  buildAssistantChatSystem,
  buildAssistantChatUser,
} from "../../lib/editor/assistant-chat-prompt";

/**
 * 会話型 AI プロンプト構築（assistant-chat-prompt）の純ロジック検証。許可セクションの反映（finding①）・
 * 基準日・会話の平坦化・下書きの許可絞り・soft-gate 対象（user ターンのみ）を固める。
 */

const TURNS: ChatTurn[] = [
  { role: "user", content: "明日の予定を作って" },
  { role: "assistant", content: "作成しました" },
  { role: "user", content: "2限を英語に" },
];

describe("buildAssistantChatSystem", () => {
  it("許可セクションのラベルと基準日を含み、許可外は作らせない指示を出す", () => {
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年6月13日（土）",
    );
    expect(sys).toContain("予定（時間割）");
    expect(sys).toContain("連絡（お知らせ）");
    expect(sys).toContain("提出物（課題）");
    expect(sys).toContain("2026年6月13日（土）");
    expect(sys).toContain("{ reply, schedules, notices, assignments }");
  });

  it("日付対応表（dateTable）を渡すと表引きで日付解決させる指示を出し、未指定なら出さない", () => {
    const table = "2026-07-06(月・今日) / 2026-07-07(火・明日)";
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年7月6日（月）",
      [],
      table,
    );
    expect(sys).toContain(table);
    expect(sys).toContain("必ずこの表から実在日付を引く");
    const without = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年7月6日（月）",
    );
    expect(without).not.toContain("対応表");
  });

  it("基準日と別の日への指示は 1 日でも days に入れる指示・偽成功（未投入の作成済み宣言）の禁止を出す", () => {
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年7月6日（月）",
    );
    expect(sys).toContain("基準日と別の日への指示");
    expect(sys).toContain("1 日だけでも top-level に入れず days に入れる");
    expect(sys).toContain("下書きに入れていない内容を作成済みと言わない");
  });

  it("日付・期間が不明なときは創作も省略もせず reply で聞き返す指示を出す", () => {
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年6月13日（土）",
    );
    expect(sys).toContain("特定できないとき");
    expect(sys).toContain("聞き返す");
    expect(sys).toContain("曖昧なまま埋めない");
  });

  it("few-shot 例を含む（曖昧→聞き返し / 既存下書きの部分編集→全体返却 / 時限外→連絡 / 連絡・提出物の修正）", () => {
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年6月13日（土）",
    );
    expect(sys).toContain("【出力例】");
    // 例1: 期限が無ければ創作せず聞き返す（assignments は空のまま）。
    expect(sys).toContain("提出期限はいつにしますか？");
    // 例2: 既存下書き（1限=数学）を保ったまま 2限だけ英語に直し、全体を返す。
    expect(sys).toContain('"period":2,"subject":"英語"');
    expect(sys).toContain('"period":1,"subject":"数学"');
    // 例3: 朝の会など時限に乗らない事項は予定でなく連絡へ。
    expect(sys).toContain("朝の会で表彰を行います。");
    // 例4: 既存連絡の部分修正（運動会→体育祭）も該当だけ直して全体を返す。
    expect(sys).toContain("体育祭は5月20日です。");
    // 例5: 既存提出物の部分修正（期限だけ 6/25 に）も該当だけ直して全体を返す。
    expect(sys).toContain('"deadline":"2026-06-25","subject":"数学","task":"ドリルp10"');
  });

  it("複数日まとめ（days）の指示・上限・few-shot を含む（schedules 許可時）", () => {
    const sys = buildAssistantChatSystem(
      ["schedules", "notices", "assignments"],
      "2026年6月13日（土）",
    );
    // 単一日の基本構造はそのまま（days は複数日のときだけ加える）。
    expect(sys).toContain("{ reply, schedules, notices, assignments }");
    // 複数日まとめの指示・最大日数・top-level を空にして days に入れる旨。
    expect(sys).toContain("複数日まとめ");
    expect(sys).toContain("days");
    expect(sys).toContain("最大 7 日分");
    // 複数日の few-shot（days に日付ごと）。
    expect(sys).toContain('"days":[{"date":"2026-06-29"');
  });

  it("複数日 few-shot も許可セクションに追従する（notices/assignments のみ許可では schedule の複数日例を出さない）", () => {
    const sys = buildAssistantChatSystem(["notices", "assignments"], "2026年6月13日（土）");
    // schedules 不許可なので schedule 駆動の複数日例（days の数学）は出さない。
    expect(sys).not.toContain('"days":[{"date":"2026-06-29"');
  });

  it("pattern2 相当（schedules のみ許可）= 予定だけを許可ラベルに出す", () => {
    const sys = buildAssistantChatSystem(["schedules"], "2026年6月13日（土）");
    expect(sys).toContain("予定（時間割）");
    expect(sys).not.toContain("連絡（お知らせ） /");
    // 「これ以外のセクションは作らない」誘導が入る。
    expect(sys).toContain("これ以外のセクションは作らない");
  });

  it("few-shot 例は許可セクションに追従する（pattern2 では schedule 編集例のみ、許可外の例は出さない）", () => {
    const sys = buildAssistantChatSystem(["schedules"], "2026年6月13日（土）");
    // schedule 編集の例は出る。
    expect(sys).toContain('"period":2,"subject":"英語"');
    // notices/assignments を populate する例は出さない（許可外を埋める誤誘導を避ける）。
    expect(sys).not.toContain("提出期限はいつにしますか？");
    expect(sys).not.toContain("朝の会で表彰を行います。");
    // 連絡・提出物の修正例も許可外では出さない。
    expect(sys).not.toContain("体育祭は5月20日です。");
    expect(sys).not.toContain('"deadline":"2026-06-25"');
  });

  it("手入力セクション（来校者/呼び出し）があれば、AIで作らず手入力フォームへ誘導させる（ADR-034）", () => {
    const sys = buildAssistantChatSystem(["schedules"], "2026年6月13日（土）", [
      "生徒呼び出し",
      "来校者一覧",
    ]);
    expect(sys).toContain("生徒呼び出し・来校者一覧");
    expect(sys).toContain("あなた（AI）は作らない");
    expect(sys).toContain("手入力フォームから追加してください");
  });

  it("手入力セクションが空（pattern1）なら誘導文を出さない", () => {
    const sys = buildAssistantChatSystem(["schedules", "notices", "assignments"], "x", []);
    expect(sys).not.toContain("手入力フォームから追加してください");
  });
});

describe("buildAssistantChatUser", () => {
  it("会話の平坦化（教員/アシスタント・敬称ラベルを避ける）と現在の下書き JSON を含む", () => {
    const draft: AssistantDraft = {
      schedules: [{ period: 1, subject: "数学" }],
      notices: [],
      assignments: [],
    };
    const user = buildAssistantChatUser(TURNS, draft, ["schedules", "notices", "assignments"]);
    expect(user).toContain("教員: 明日の予定を作って");
    expect(user).toContain("アシスタント: 作成しました");
    expect(user).toContain("教員: 2限を英語に");
    // 役割ラベルに敬称「先生」を使わない（soft-gate ヒューリスティックの誤発火を避ける）。
    expect(user).not.toContain("先生:");
    expect(user).toContain('"schedules":[{"period":1,"subject":"数学"}]');
  });

  it("下書きは許可セクションだけに絞って渡す（許可外は空配列で文脈に入れない）", () => {
    const draft: AssistantDraft = {
      schedules: [{ period: 1, subject: "数学" }],
      notices: [{ text: "連絡" }],
      assignments: [],
    };
    const user = buildAssistantChatUser(TURNS, draft, ["schedules"]);
    expect(user).toContain('"notices":[]');
    expect(user).not.toContain("連絡");
  });
});
