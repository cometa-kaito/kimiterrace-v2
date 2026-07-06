import { describe, expect, it } from "vitest";
import {
  assistantGreeting,
  draftItemMeta,
  resolveAllowedSections,
  resolveDraftSectionLabels,
  resolveManualSectionLabels,
} from "../../lib/editor/assistant-sections";

/**
 * パターン準拠セクション解決（assistant-sections）の検証。其他レーンの単一ソース `PATTERN_BLOCKS`
 * （`editableBlocksForPattern`）を consume し、会話型 AI が下書きできるセクション（schedule/notice/
 * assignment）と、AI が作らない手入力セクション（来校者/呼び出し・ADR-034）を導く（finding①）。
 * 本テストは実 PATTERN_BLOCKS を使う（独自表を作らない＝ドリフトしたら本テストが落ちて気づける）。
 * ラベル・歓迎文はパターン別上書き（blockLabel §6.2）込みで固定する（v2-ed47-5 のドリフトガード）。
 */

describe("resolveAllowedSections", () => {
  it("pattern1 = 予定/連絡/提出物（3 種とも AI 下書き可）", () => {
    expect(resolveAllowedSections("pattern1")).toEqual(["schedules", "notices", "assignments"]);
  });

  it("pattern2 = 予定のみ（来校者/呼び出しは AI 生成しない・ADR-034）", () => {
    expect(resolveAllowedSections("pattern2")).toEqual(["schedules"]);
  });

  it("pattern5（掲示板型）= お知らせ（notices）と今日の予定（schedules）・notice 主役の順（§6.1）", () => {
    expect(resolveAllowedSections("pattern5")).toEqual(["notices", "schedules"]);
  });
});

describe("resolveManualSectionLabels", () => {
  it("pattern1 は手入力セクション無し（編集ブロックは全て AI 下書き可）", () => {
    expect(resolveManualSectionLabels("pattern1")).toEqual([]);
  });

  it("pattern2 は来校者/呼び出しを手入力ラベルとして返す（AI 誘導用）", () => {
    expect(resolveManualSectionLabels("pattern2")).toEqual(["生徒呼び出し", "来校者一覧"]);
  });

  it("pattern5 は手入力セクション無し（お知らせ / 今日の予定はどちらも AI 下書き可）", () => {
    expect(resolveManualSectionLabels("pattern5")).toEqual([]);
  });
});

describe("resolveDraftSectionLabels（AI 下書き対象の表示ラベル・blockLabel §6.2 経由）", () => {
  it("pattern1 = 予定・連絡・提出物 / pattern2 = 予定 / pattern4 = 連絡", () => {
    expect(resolveDraftSectionLabels("pattern1")).toEqual(["予定", "連絡", "提出物"]);
    expect(resolveDraftSectionLabels("pattern2")).toEqual(["予定"]);
    expect(resolveDraftSectionLabels("pattern4")).toEqual(["連絡"]);
  });

  it("pattern5 は上書きラベル（お知らせ・今日の予定）を盤面の並び順で返す", () => {
    expect(resolveDraftSectionLabels("pattern5")).toEqual(["お知らせ", "今日の予定"]);
  });
});

describe("assistantGreeting（歓迎文のパターン合成・v2-ed47-5 の根治 §6.4）", () => {
  it("pattern1 は従来の固定文言と同値（回帰なし）", () => {
    expect(assistantGreeting("pattern1")).toBe(
      "今日の連絡、話しかけてください。話す・書く・ファイルでOK。予定・連絡・提出物にまとめて下書きします。",
    );
  });

  it("pattern2/3 は下書き対象=予定＋呼び出し/来校者の手入力誘導（ADR-034 の文言化）", () => {
    for (const pattern of ["pattern2", "pattern3"] as const) {
      expect(assistantGreeting(pattern)).toBe(
        "今日の連絡、話しかけてください。話す・書く・ファイルでOK。予定にまとめて下書きします。生徒呼び出し・来校者一覧は氏名を含むため下のフォームから入力してください。",
      );
    }
  });

  it("pattern4 は連絡のみ", () => {
    expect(assistantGreeting("pattern4")).toBe(
      "今日の連絡、話しかけてください。話す・書く・ファイルでOK。連絡にまとめて下書きします。",
    );
  });

  it("pattern5（掲示板型）は掲示板語彙（お知らせ・今日の予定）で下書き対象を伝える", () => {
    expect(assistantGreeting("pattern5")).toBe(
      "今日の連絡、話しかけてください。話す・書く・ファイルでOK。お知らせ・今日の予定にまとめて下書きします。",
    );
  });

  // 2026-07-06 実画面監査 P2-1: 16 時カットオーバー後の編集対象日は翌授業日で「今日の連絡」が嘘になる。
  // dateLabel つきは対象日を冒頭で明示する（省略時＝上記の従来文言は不変）。
  it("dateLabel つきは対象日を明示する（パターン別セクション列挙は維持）", () => {
    expect(assistantGreeting("pattern1", "7/15（水）")).toBe(
      "7/15（水）の盤面を作ります。話しかけてください。話す・書く・ファイルでOK。予定・連絡・提出物にまとめて下書きします。",
    );
    expect(assistantGreeting("pattern2", "7/15（水）")).toBe(
      "7/15（水）の盤面を作ります。話しかけてください。話す・書く・ファイルでOK。予定にまとめて下書きします。生徒呼び出し・来校者一覧は氏名を含むため下のフォームから入力してください。",
    );
  });
});

describe("draftItemMeta（確認カードの詳細併記・2026-07-06 監査 P2-4）", () => {
  it("予定: 場所（＠〜）・対象者（対象: 〜）・重要★を、存在するものだけ併記する", () => {
    expect(
      draftItemMeta("schedules", {
        period: 2,
        subject: "理科",
        location: "理科室",
        targetAudience: "3年生",
        isHighlight: true,
      }),
    ).toBe("＠理科室 対象: 3年生 ★");
    expect(draftItemMeta("schedules", { period: 2, subject: "理科", location: "理科室" })).toBe(
      "＠理科室",
    );
    expect(draftItemMeta("schedules", { period: 2, subject: "理科" })).toBeNull();
  });

  it("予定の区切り線（divider・詳細フィールドなし）は併記なし", () => {
    expect(draftItemMeta("schedules", { kind: "divider", subject: "午後の部" })).toBeNull();
  });

  it("連絡: 表示日数>1（N日間表示）・重要★。pinned は出さない（保存時 demote と乖離させない・#1250 LOW）", () => {
    expect(draftItemMeta("notices", { text: "持久走大会があります", displayDays: 3 })).toBe(
      "3日間表示",
    );
    // pinned は AI 反映時に preservePinnedNotices が demote するため、カードで「固定」を約束しない。
    expect(draftItemMeta("notices", { text: "校訓", pinned: true })).toBeNull();
    expect(draftItemMeta("notices", { text: "重要な連絡", isHighlight: true })).toBe("★");
    expect(draftItemMeta("notices", { text: "ふつうの連絡" })).toBeNull();
    // 表示日数 1（既定＝入力日のみ）は併記しない（ノイズにしない）。
    expect(draftItemMeta("notices", { text: "当日のみ", displayDays: 1 })).toBeNull();
  });

  it("提出物: 重要★のみ（期限は formatSignageItem の本文「（〆M/D）」が既に表示）", () => {
    expect(
      draftItemMeta("assignments", {
        deadline: "2026-07-17",
        subject: "数学",
        task: "プリント",
        isHighlight: true,
      }),
    ).toBe("★");
    expect(
      draftItemMeta("assignments", { deadline: "2026-07-17", subject: "数学", task: "プリント" }),
    ).toBeNull();
  });
});
