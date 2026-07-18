import { describe, expect, it } from "vitest";
import {
  type CalloutRow,
  DIVIDER_LABEL_MAX,
  buildBulletinNoticesFromCallouts,
  classifyCalloutText,
  convertScheduleDashRows,
  effectiveDesignPattern,
  extractDesignParam,
  extractSignageToken,
  isDashOnly,
  mergePinnedNotices,
  planBulletinMigration,
} from "../../src/migrate-shinro-bulletin.js";

/**
 * PR-E 掲示板型移行の純ロジック単体検証（DB 不要）。安全設計の要（未選択 text 行を自動 pin しない・冪等・
 * 端末トークン/パターン解決）を固定する。callout の生テキスト（実名を含みうる）は assert で最小限に留める。
 */

describe("isDashOnly / classifyCalloutText", () => {
  it("全ダッシュ類は divider（ラベル空）", () => {
    expect(isDashOnly("------------------")).toBe(true);
    expect(isDashOnly("―― ＝＝ __")).toBe(true);
    expect(classifyCalloutText("------------------")).toEqual({ kind: "divider", label: "" });
  });

  it("ダッシュ包み見出し「------ 校訓 ------」は divider（内側をラベルに）", () => {
    expect(classifyCalloutText("------ 校訓 ------")).toEqual({ kind: "divider", label: "校訓" });
    expect(classifyCalloutText("―― 進路情報 ――")).toEqual({ kind: "divider", label: "進路情報" });
  });

  it("校訓本文・氏名は text（自動 divider にしない＝要明示選択）", () => {
    expect(classifyCalloutText("礼儀正しく 勤労を尊び")).toEqual({
      kind: "text",
      text: "礼儀正しく 勤労を尊び",
    });
    // 氏名も text（分類は内容で氏名/本文を区別しない＝PII 安全側）。
    expect(classifyCalloutText("田中太郎").kind).toBe("text");
  });

  it("非対称（片側だけダッシュ）は divider にしない（fail-safe）", () => {
    expect(classifyCalloutText("校訓 ------").kind).toBe("text");
    expect(classifyCalloutText("------ 校訓").kind).toBe("text");
  });

  it("空・空白のみは empty（trim 後に空）", () => {
    expect(classifyCalloutText("")).toEqual({ kind: "empty" });
    expect(classifyCalloutText("   ")).toEqual({ kind: "empty" });
  });

  it("長いラベルは DIVIDER_LABEL_MAX で切り詰め", () => {
    const long = `------ ${"あ".repeat(50)} ------`;
    const cls = classifyCalloutText(long);
    expect(cls.kind).toBe("divider");
    if (cls.kind === "divider") {
      expect(cls.label.length).toBe(DIVIDER_LABEL_MAX);
    }
  });
});

describe("extractSignageToken", () => {
  it("/signage/<token> を取り出す（?design 付きも）", () => {
    expect(
      extractSignageToken("https://app.school-signage.net/signage/ABC123?design=pattern3"),
    ).toBe("ABC123");
    expect(extractSignageToken("https://app.school-signage.net/signage/ABC123")).toBe("ABC123");
  });

  it("非該当・不正・null は null", () => {
    expect(extractSignageToken("https://app.school-signage.net/")).toBeNull();
    expect(extractSignageToken("https://app.school-signage.net/?school=x&class=y")).toBeNull();
    expect(extractSignageToken("not a url")).toBeNull();
    expect(extractSignageToken(null)).toBeNull();
    expect(extractSignageToken(undefined)).toBeNull();
  });
});

describe("extractDesignParam / effectiveDesignPattern", () => {
  it("?design= を取り出す。未指定は既定 pattern1", () => {
    expect(extractDesignParam("https://x.test/signage/T?design=pattern5")).toBe("pattern5");
    expect(extractDesignParam("https://x.test/signage/T")).toBeNull();
    expect(effectiveDesignPattern("https://x.test/signage/T?design=pattern3")).toBe("pattern3");
    expect(effectiveDesignPattern("https://x.test/signage/T")).toBe("pattern1");
  });

  it("未知パターンは実効 pattern1（fail-soft）", () => {
    expect(effectiveDesignPattern("https://x.test/signage/T?design=bogus")).toBe("pattern1");
  });
});

describe("convertScheduleDashRows", () => {
  it("subject が全ダッシュの行を区切り線に（位置保持・count）", () => {
    const input = [
      { period: 1, subject: "国語" },
      { subject: "------------------" },
      { period: 2, subject: "数学" },
    ];
    const { next, convertedCount, skippedNonArray } = convertScheduleDashRows(input);
    expect(skippedNonArray).toBe(false);
    expect(convertedCount).toBe(1);
    expect(next[0]).toEqual({ period: 1, subject: "国語" });
    expect(next[1]).toEqual({ kind: "divider", subject: "" });
    expect(next[2]).toEqual({ period: 2, subject: "数学" });
  });

  it("既に divider の行は不変（冪等）・非ダッシュ subject は不変", () => {
    const input = [
      { kind: "divider", subject: "" },
      { period: 1, subject: "----授業----" },
    ];
    const { convertedCount } = convertScheduleDashRows(input);
    // "----授業----" は非対称でなく両端ダッシュだが schedule は「全ダッシュのみ」変換（ラベル包みは対象外）。
    expect(convertedCount).toBe(0);
  });

  it("配列でなければ変換なし", () => {
    expect(convertScheduleDashRows(null)).toEqual({
      next: [],
      convertedCount: 0,
      skippedNonArray: true,
    });
    expect(convertScheduleDashRows({}).skippedNonArray).toBe(true);
  });
});

describe("buildBulletinNoticesFromCallouts", () => {
  const rows: CalloutRow[] = [
    { id: "d1", calloutDate: "2026-07-01", studentName: "------ 校訓 ------", sortOrder: 0 },
    { id: "b1", calloutDate: "2026-07-01", studentName: "礼儀正しく 勤労を尊び", sortOrder: 1 },
    { id: "n1", calloutDate: "2026-07-01", studentName: "田中太郎", sortOrder: 2 },
  ];

  it("divider は自動 pin・本文は選択時のみ pin・未選択 text は未分類（残置）", () => {
    const out = buildBulletinNoticesFromCallouts(rows, ["b1"]);
    expect(out.dividerCalloutIds).toEqual(["d1"]);
    expect(out.bodyCalloutIds).toEqual(["b1"]);
    expect(out.unclassifiedCalloutIds).toEqual(["n1"]);
    expect(out.items).toEqual([
      { kind: "divider", text: "校訓", pinned: true },
      { text: "礼儀正しく 勤労を尊び", pinned: true },
    ]);
  });

  it("選択が無ければ本文も氏名も pin しない（安全既定）", () => {
    const out = buildBulletinNoticesFromCallouts(rows, []);
    expect(out.bodyCalloutIds).toEqual([]);
    expect(out.items).toEqual([{ kind: "divider", text: "校訓", pinned: true }]);
    expect(out.unclassifiedCalloutIds).toEqual(["b1", "n1"]);
  });

  it("複数日の同一校訓は 1 件に集約（signature dedup）", () => {
    const multi: CalloutRow[] = [
      { id: "d1", calloutDate: "2026-07-01", studentName: "------ 校訓 ------", sortOrder: 0 },
      { id: "d2", calloutDate: "2026-07-02", studentName: "------ 校訓 ------", sortOrder: 0 },
    ];
    const out = buildBulletinNoticesFromCallouts(multi, []);
    expect(out.dividerCalloutIds).toEqual(["d1", "d2"]); // 両方削除対象
    expect(out.items).toEqual([{ kind: "divider", text: "校訓", pinned: true }]); // 表示は 1 件
  });
});

describe("mergePinnedNotices（冪等追記）", () => {
  it("新規は追記・同一 signature は追記しない", () => {
    const existing = [{ text: "既存連絡" }, { kind: "divider", text: "校訓", pinned: true }];
    const additions = [
      { kind: "divider" as const, text: "校訓", pinned: true }, // 既存 → skip
      { text: "礼儀正しく 勤労を尊び", pinned: true }, // 新規 → 追記
    ];
    const { next, addedCount } = mergePinnedNotices(existing, additions);
    expect(addedCount).toBe(1);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ text: "礼儀正しく 勤労を尊び", pinned: true });
  });

  it("既存が配列でなければ空配列扱い", () => {
    const { next, addedCount } = mergePinnedNotices(null, [{ text: "x", pinned: true }]);
    expect(addedCount).toBe(1);
    expect(next).toEqual([{ text: "x", pinned: true }]);
  });
});

describe("planBulletinMigration", () => {
  const dailyRows = [
    {
      rowId: "r1",
      date: "2026-07-01",
      schedules: [{ subject: "----" }, { period: 1, subject: "国語" }],
    },
    { rowId: "r2", date: "2026-07-02", schedules: [{ period: 1, subject: "数学" }] },
  ];
  const callouts: CalloutRow[] = [
    { id: "d1", calloutDate: "2026-07-03", studentName: "------ 校訓 ------", sortOrder: 0 },
    { id: "b1", calloutDate: "2026-07-01", studentName: "礼儀正しく", sortOrder: 1 },
  ];

  it("schedule 変換を集約し、アンカー日は変換対象 callout の最古日", () => {
    const plan = planBulletinMigration({
      dailyRows,
      callouts,
      selectedBodyIds: ["b1"],
      anchorDateFallback: "2026-12-31",
    });
    expect(plan.totalScheduleDividers).toBe(1);
    expect(plan.scheduleConversions.map((c) => c.rowId)).toEqual(["r1"]); // r2 は変換ゼロで除外
    expect(plan.deleteCalloutIds.sort()).toEqual(["b1", "d1"]);
    // d1(07-03) と b1(07-01) の最古 → 07-01
    expect(plan.anchorDate).toBe("2026-07-01");
    expect(plan.pinnedNotices).toEqual([
      { kind: "divider", text: "校訓", pinned: true },
      { text: "礼儀正しく", pinned: true },
    ]);
  });

  it("anchorDateOverride を優先", () => {
    const plan = planBulletinMigration({
      dailyRows,
      callouts,
      selectedBodyIds: ["b1"],
      anchorDateOverride: "2026-04-01",
      anchorDateFallback: "2026-12-31",
    });
    expect(plan.anchorDate).toBe("2026-04-01");
  });

  it("固定お知らせが無ければ anchorDate は null", () => {
    const plan = planBulletinMigration({
      dailyRows,
      callouts: [],
      selectedBodyIds: [],
      anchorDateFallback: "2026-12-31",
    });
    expect(plan.pinnedNotices).toEqual([]);
    expect(plan.anchorDate).toBeNull();
  });
});
