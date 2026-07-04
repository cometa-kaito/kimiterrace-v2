import { describe, expect, it } from "vitest";
import {
  type DailyScopeRow,
  addDays,
  daysBetween,
  isAssignmentActive,
  isNoticeActive,
  mergeDailySections,
  mergeEffectiveWithWindow,
} from "../../lib/signage/effective-daily-data";

/**
 * daily_data 階層マージ (class > grade > school、per-field) の純粋ロジック検証 (#48-E1)。
 */

function row(scope: DailyScopeRow["scope"], parts: Partial<DailyScopeRow>): DailyScopeRow {
  return {
    scope,
    schedules: parts.schedules ?? [],
    notices: parts.notices ?? [],
    assignments: parts.assignments ?? [],
    quietHours: parts.quietHours ?? [],
  };
}

describe("mergeDailySections", () => {
  it("各セクションで最も具体的な非空 scope を採用 (class > grade > school)", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("school", { schedules: ["S校"], notices: ["N校"], assignments: ["A校"] }),
      row("grade", { notices: ["N学年"] }),
      row("class", { schedules: ["S組"] }),
    ]);
    // schedules: class が非空 → class
    expect(merged.schedules).toEqual({ items: ["S組"], source: "class" });
    // notices: class 空 / grade 非空 → grade
    expect(merged.notices).toEqual({ items: ["N学年"], source: "grade" });
    // assignments: class/grade 空 / school 非空 → school
    expect(merged.assignments).toEqual({ items: ["A校"], source: "school" });
    // quietHours: 全空 → source null
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });

  it("date はそのまま透過", () => {
    expect(mergeDailySections("2026-01-09", []).date).toBe("2026-01-09");
  });

  it("空配列・非配列は「無し」として扱い下位 scope にフォールバック", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("class", { schedules: [] }), // 空 → スキップ
      row("school", { schedules: ["S校"] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["S校"], source: "school" });
  });

  it("該当 scope 行が無くても安全 (全セクション空)", () => {
    const merged = mergeDailySections("2026-05-30", []);
    for (const sec of [merged.schedules, merged.notices, merged.assignments, merged.quietHours]) {
      expect(sec).toEqual({ items: [], source: null });
    }
  });

  it("department scope は school より優先 / grade より下 (段A-2: class > grade > department > school)", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("school", { schedules: ["S校"], notices: ["N校"], assignments: ["A校"] }),
      row("department", { schedules: ["S学科"], notices: ["N学科"] }),
      row("grade", { schedules: ["S学年"] }),
    ]);
    // schedules: grade 非空 → grade (department/school より優先)
    expect(merged.schedules).toEqual({ items: ["S学年"], source: "grade" });
    // notices: grade 空 / department 非空 → department (school より優先)
    expect(merged.notices).toEqual({ items: ["N学科"], source: "department" });
    // assignments: grade/department 空 / school 非空 → school
    expect(merged.assignments).toEqual({ items: ["A校"], source: "school" });
  });

  it("department のみ非空なら department を採用 (学科全体編集がサイネージに反映される)", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("department", { schedules: ["S学科"] }),
      row("school", { schedules: [] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["S学科"], source: "department" });
  });

  it("class > grade > department > school の完全な優先順", () => {
    const merged = mergeDailySections("2026-05-30", [
      row("class", { schedules: ["S組"] }),
      row("grade", { schedules: ["S学年"] }),
      row("department", { schedules: ["S学科"] }),
      row("school", { schedules: ["S校"] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["S組"], source: "class" });
  });

  it("class スコープ採用時は source=class (継承バッジを出さない側)", () => {
    const merged = mergeDailySections("2026-05-30", [row("class", { notices: ["緊急"] })]);
    expect(merged.notices.source).toBe("class");
  });
});

/**
 * 静粛時間 (quiet_hours) の二段フォールバック (#191、#48-J-2 配線)。
 * 優先順: 当日 daily_data の override (階層マージ結果) > school_configs クラス既定 (永続)。
 * `quietHoursFallback` は school_configs `{ ranges }` から取り出した配列 (値形ブリッジ済) を渡す。
 */
describe("mergeDailySections: quiet_hours 二段フォールバック (#191)", () => {
  const dailyRange = [{ start: "08:00", end: "08:30" }];
  const configRange = [{ start: "12:00", end: "13:00" }];

  it("daily_data に quiet_hours override があれば既定より優先 (override > default)", () => {
    const merged = mergeDailySections(
      "2026-05-31",
      [row("class", { quietHours: dailyRange })],
      configRange,
    );
    expect(merged.quietHours).toEqual({ items: dailyRange, source: "class" });
  });

  it("daily_data に無く school_configs クラス既定があればそれを採用 (default、source=class)", () => {
    const merged = mergeDailySections("2026-05-31", [], configRange);
    expect(merged.quietHours).toEqual({ items: configRange, source: "class" });
  });

  it("daily_data の quiet_hours が空配列でも既定にフォールバックする", () => {
    const merged = mergeDailySections(
      "2026-05-31",
      [row("class", { quietHours: [] })],
      configRange,
    );
    expect(merged.quietHours).toEqual({ items: configRange, source: "class" });
  });

  it("両方なし (既定 null) → 空 source null", () => {
    const merged = mergeDailySections("2026-05-31", [], null);
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });

  it("既定が空配列のときも空 source null (空既定はフォールバックしない)", () => {
    const merged = mergeDailySections("2026-05-31", [], []);
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });

  it("既定は他セクション (schedules/notices/assignments) には影響しない", () => {
    const merged = mergeDailySections(
      "2026-05-31",
      [row("school", { schedules: ["S校"] })],
      configRange,
    );
    expect(merged.schedules).toEqual({ items: ["S校"], source: "school" });
    expect(merged.notices).toEqual({ items: [], source: null });
    expect(merged.assignments).toEqual({ items: [], source: null });
    // quiet_hours だけ既定が効く
    expect(merged.quietHours).toEqual({ items: configRange, source: "class" });
  });

  it("daily_data grade/school scope に quiet_hours があれば既定より優先 (override は scope を問わない)", () => {
    const gradeRange = [{ start: "15:00", end: "16:00" }];
    const merged = mergeDailySections(
      "2026-05-31",
      [row("grade", { quietHours: gradeRange })],
      configRange,
    );
    // grade の override が既定より優先。source は採用 scope (grade)。
    expect(merged.quietHours).toEqual({ items: gradeRange, source: "grade" });
  });

  it("既定引数を省略すると従来挙動 (空 source null)", () => {
    const merged = mergeDailySections("2026-05-31", []);
    expect(merged.quietHours).toEqual({ items: [], source: null });
  });
});

/** 遡及窓の 1 行 (DailyScopeRow + 入力日)。 */
function wrow(scope: DailyScopeRow["scope"], date: string, parts: Partial<DailyScopeRow>) {
  return {
    scope,
    date,
    schedules: parts.schedules ?? [],
    notices: parts.notices ?? [],
    assignments: parts.assignments ?? [],
    quietHours: parts.quietHours ?? [],
  };
}

describe("daysBetween / addDays", () => {
  it("daysBetween は暦日差 (to - from)、月/年跨ぎも正しい", () => {
    expect(daysBetween("2026-06-07", "2026-06-10")).toBe(3);
    expect(daysBetween("2026-06-10", "2026-06-07")).toBe(-3);
    expect(daysBetween("2026-06-30", "2026-07-01")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });
  it("addDays は n 日加算 (月/年跨ぎ・負数)", () => {
    expect(addDays("2026-06-07", 3)).toBe("2026-06-10");
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-06-07", -30)).toBe("2026-05-08");
  });
});

describe("isNoticeActive", () => {
  it("既定 (displayDays 無し) は入力日のみ", () => {
    expect(isNoticeActive({ text: "x" }, "2026-06-07", "2026-06-07")).toBe(true);
    expect(isNoticeActive({ text: "x" }, "2026-06-06", "2026-06-07")).toBe(false);
  });
  it("displayDays=3 は入力日から 3 日間 (当日含む)、4 日目は切れる", () => {
    const item = { text: "x", displayDays: 3 };
    expect(isNoticeActive(item, "2026-06-05", "2026-06-05")).toBe(true);
    expect(isNoticeActive(item, "2026-06-05", "2026-06-07")).toBe(true);
    expect(isNoticeActive(item, "2026-06-05", "2026-06-08")).toBe(false);
  });
  it("未来入力 (today < rowDate) は非活性", () => {
    expect(isNoticeActive({ text: "x", displayDays: 5 }, "2026-06-10", "2026-06-07")).toBe(false);
  });
  it("pinned (固定表示・§5.4) は入力日以降ずっと活性 (displayDays 非依存・14 日超も表示)", () => {
    const pinnedItem = { text: "校訓", pinned: true };
    expect(isNoticeActive(pinnedItem, "2026-05-01", "2026-05-01")).toBe(true);
    expect(isNoticeActive(pinnedItem, "2026-05-01", "2026-07-04")).toBe(true); // 60 日超
    // 未来入力はまだ非活性 (入力日から表示開始)。
    expect(isNoticeActive(pinnedItem, "2026-07-10", "2026-07-04")).toBe(false);
    // pinned は displayDays が残っていても勝つ (validate は剥がすが JSONB 由来を防御的に)。
    expect(
      isNoticeActive({ text: "x", pinned: true, displayDays: 3 }, "2026-05-01", "2026-07-04"),
    ).toBe(true);
    // pinned が true 以外なら従来判定 (fail-soft)。
    expect(isNoticeActive({ text: "x", pinned: "true" }, "2026-05-01", "2026-07-04")).toBe(false);
  });
  it("pinned な divider (区切り線ごと固定・§5.4) もずっと活性", () => {
    expect(
      isNoticeActive({ kind: "divider", text: "校訓", pinned: true }, "2026-05-01", "2026-07-04"),
    ).toBe(true);
  });
  it("区切り線 (kind:'divider') も通常行と同一のライフサイクル (§5.3 MEDIUM-1)", () => {
    // divider は「本文が罫線であるだけの行」。displayDays=3 なら翌日以降も残り、
    // 多日連絡のグルーピング（校訓掲示板等）が崩れない。displayDays 欠落は既定 1（入力日のみ）。
    const divider = { kind: "divider", text: "校訓", displayDays: 3 };
    expect(isNoticeActive(divider, "2026-06-05", "2026-06-06")).toBe(true);
    expect(isNoticeActive(divider, "2026-06-05", "2026-06-07")).toBe(true);
    expect(isNoticeActive(divider, "2026-06-05", "2026-06-08")).toBe(false);
    expect(isNoticeActive({ kind: "divider", text: "" }, "2026-06-05", "2026-06-06")).toBe(false);
  });
});

describe("isAssignmentActive (期限 + 2 日まで)", () => {
  it("期限前〜期限+2日は活性、+3日で消える", () => {
    const a = { deadline: "2026-06-10", subject: "数学", task: "p10" };
    expect(isAssignmentActive(a, "2026-06-05")).toBe(true);
    expect(isAssignmentActive(a, "2026-06-10")).toBe(true);
    expect(isAssignmentActive(a, "2026-06-12")).toBe(true);
    expect(isAssignmentActive(a, "2026-06-13")).toBe(false);
  });
  it("deadline が無い/不正は非活性", () => {
    expect(isAssignmentActive({ subject: "x" }, "2026-06-10")).toBe(false);
    expect(isAssignmentActive(null, "2026-06-10")).toBe(false);
  });
});

describe("mergeEffectiveWithWindow", () => {
  it("連絡: 数日前入力の displayDays>1 が今日も活性なら表示", () => {
    const merged = mergeEffectiveWithWindow("2026-06-07", [
      wrow("class", "2026-06-05", { notices: [{ text: "三日間連絡", displayDays: 3 }] }),
    ]);
    expect(merged.notices).toEqual({
      items: [{ text: "三日間連絡", displayDays: 3 }],
      source: "class",
    });
  });

  it("連絡: 表示日数が切れた連絡は出さず下位 scope にフォールバック", () => {
    const merged = mergeEffectiveWithWindow("2026-06-07", [
      wrow("class", "2026-06-05", { notices: [{ text: "今日のみ(切れ)" }] }),
      wrow("school", "2026-06-07", { notices: [{ text: "学校連絡" }] }),
    ]);
    expect(merged.notices).toEqual({ items: [{ text: "学校連絡" }], source: "school" });
  });

  it("連絡: 区切り線も displayDays>1 なら翌日に残り、多日グルーピングが崩れない (§5.3 MEDIUM-1)", () => {
    const merged = mergeEffectiveWithWindow("2026-06-06", [
      wrow("class", "2026-06-05", {
        notices: [
          { kind: "divider", text: "校訓", displayDays: 3 },
          { text: "多日連絡", displayDays: 3 },
        ],
      }),
    ]);
    // 区切り線→本文の並び（グルーピング）が翌日もそのまま出る。
    expect(merged.notices.items).toEqual([
      { kind: "divider", text: "校訓", displayDays: 3 },
      { text: "多日連絡", displayDays: 3 },
    ]);
  });

  it("提出物: 期限+2日まで自動表示、+3日で消える", () => {
    const a = { deadline: "2026-06-06", subject: "国語", task: "漢字" };
    const active = mergeEffectiveWithWindow("2026-06-08", [
      wrow("class", "2026-06-01", { assignments: [a] }),
    ]);
    expect(active.assignments.items).toEqual([a]);
    const expired = mergeEffectiveWithWindow("2026-06-09", [
      wrow("class", "2026-06-01", { assignments: [a] }),
    ]);
    expect(expired.assignments).toEqual({ items: [], source: null });
  });

  it("提出物: 複数日入力ぶんを期限昇順に統合", () => {
    const merged = mergeEffectiveWithWindow("2026-06-07", [
      wrow("class", "2026-06-06", {
        assignments: [{ deadline: "2026-06-12", subject: "数", task: "t1" }],
      }),
      wrow("class", "2026-06-07", {
        assignments: [{ deadline: "2026-06-08", subject: "国", task: "t2" }],
      }),
    ]);
    expect(merged.assignments.items).toEqual([
      { deadline: "2026-06-08", subject: "国", task: "t2" },
      { deadline: "2026-06-12", subject: "数", task: "t1" },
    ]);
  });

  it("schedules/quietHours は当日行のみで判定 (窓の過去日は無視)", () => {
    const merged = mergeEffectiveWithWindow("2026-06-07", [
      wrow("class", "2026-06-05", { schedules: ["過去の時間割"] }),
      wrow("class", "2026-06-07", { schedules: ["今日の時間割"] }),
    ]);
    expect(merged.schedules).toEqual({ items: ["今日の時間割"], source: "class" });
  });
});

/**
 * PR-C 固定行 (pinned・§5.4): 遡及窓 (31 日) の**外**の行も getEffectiveDailyData の JSONB 包含 OR で
 * 取得される前提で、マージ層が pinned を「ずっと活性」として通すことを固める (窓クエリ自体の DB 検証は
 * packages/db の daily-window RLS テスト側)。
 */
describe("mergeEffectiveWithWindow: 固定行 (pinned・§5.4)", () => {
  it("窓の外 (60 日前入力) の pinned が今日も表示され、同一 scope の当日連絡と統合 (入力日昇順=古い固定が先)", () => {
    const merged = mergeEffectiveWithWindow("2026-07-04", [
      wrow("class", "2026-05-05", {
        notices: [
          { kind: "divider", text: "校訓", pinned: true },
          { text: "礼儀正しく 勤労を尊び", pinned: true },
          { text: "当日のみ(切れ)" },
        ],
      }),
      wrow("class", "2026-07-04", { notices: [{ text: "今日の連絡" }] }),
    ]);
    expect(merged.notices).toEqual({
      items: [
        { kind: "divider", text: "校訓", pinned: true },
        { text: "礼儀正しく 勤労を尊び", pinned: true },
        { text: "今日の連絡" },
      ],
      source: "class",
    });
  });

  it("pinned でも per-field 最具体勝ちは不変 (class に活性 pinned があれば school 連絡は採らない)", () => {
    const merged = mergeEffectiveWithWindow("2026-07-04", [
      wrow("class", "2026-05-05", { notices: [{ text: "固定", pinned: true }] }),
      wrow("school", "2026-07-04", { notices: [{ text: "学校連絡" }] }),
    ]);
    expect(merged.notices).toEqual({ items: [{ text: "固定", pinned: true }], source: "class" });
  });
});
