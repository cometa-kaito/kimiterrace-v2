import { describe, expect, it } from "vitest";
import type { AuthUser } from "../../lib/auth/session";
import {
  DAILY_DATA_EDITOR_ROLES,
  EDITOR_ROLES,
  SCHEDULE_SLOT_OPTIONS,
  isValidDate,
  scheduleSlotLabel,
  scheduleSlotSortKey,
  toEditorActor,
  toScopedEditorActor,
  validateScheduleItems,
} from "../../lib/editor/schedule-core";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("isValidDate", () => {
  it("実在する YYYY-MM-DD は true", () => {
    expect(isValidDate("2026-05-31")).toBe(true);
  });
  it("形式不正・実在しない日は false", () => {
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026/05/31")).toBe(false);
    expect(isValidDate("")).toBe(false);
  });
});

describe("toEditorActor", () => {
  it("school_id があれば actor", () => {
    const u: AuthUser = { uid: "u1", role: "teacher", schoolId: UUID };
    expect(toEditorActor(u)).toEqual({ userId: "u1", schoolId: UUID });
  });
  it("school_id null は null", () => {
    expect(toEditorActor({ uid: "u1", role: "system_admin", schoolId: null })).toBeNull();
  });
});

describe("DAILY_DATA_EDITOR_ROLES", () => {
  it("daily_data 3 action 用は EDITOR_ROLES + system_admin", () => {
    expect(DAILY_DATA_EDITOR_ROLES).toEqual(["school_admin", "teacher", "system_admin"]);
  });
  it("EDITOR_ROLES は据え置き (callouts/visitors/assistant が共有、system_admin 非含)", () => {
    expect(EDITOR_ROLES).toEqual(["school_admin", "teacher"]);
  });
});

describe("toScopedEditorActor", () => {
  const teacher: AuthUser = { uid: "u1", role: "teacher", schoolId: UUID };
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("tenant ロール: 自校 actor を返す (userRef=uid / identityUid=null)", () => {
    expect(toScopedEditorActor(teacher)).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
    // school_admin も同じ三系統。
    expect(toScopedEditorActor({ ...teacher, role: "school_admin" })).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
  });

  it("tenant ロール: targetSchoolId(他校) は無視し必ず自校に固定する (越境防止)", () => {
    expect(toScopedEditorActor(teacher, OTHER)).toEqual({
      actorUserId: "u1",
      userRef: "u1",
      identityUid: null,
      schoolId: UUID,
    });
  });

  it("tenant ロール: 自校 (schoolId) が無ければ null", () => {
    expect(toScopedEditorActor({ ...teacher, schoolId: null })).toBeNull();
  });

  it("system_admin: 対象校指定で actor (userRef=null で FK 回避 / identityUid=uid)", () => {
    expect(toScopedEditorActor({ uid: "u1", role: "system_admin", schoolId: null }, UUID)).toEqual({
      actorUserId: "u1",
      userRef: null,
      identityUid: "u1",
      schoolId: UUID,
    });
  });

  it("system_admin: 対象校未指定 / 非 UUID は null (呼出側が forbidden 化)", () => {
    expect(toScopedEditorActor({ uid: "u1", role: "system_admin", schoolId: null })).toBeNull();
    expect(
      toScopedEditorActor({ uid: "u1", role: "system_admin", schoolId: null }, "nope"),
    ).toBeNull();
  });
});

describe("validateScheduleItems", () => {
  it("正常: period 昇順に正規化 + note 任意", () => {
    const r = validateScheduleItems([
      { period: 2, subject: " 数学 " },
      { period: 1, subject: "国語", note: "教室変更" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { period: 1, subject: "国語", note: "教室変更" },
        { period: 2, subject: "数学" },
      ],
    });
  });

  it("文字列 period も受理", () => {
    const r = validateScheduleItems([{ period: "3", subject: "理科" }]);
    expect(r.ok && r.value[0]?.period).toBe(3);
  });

  it("配列でない入力は拒否", () => {
    expect(validateScheduleItems({}).ok).toBe(false);
    expect(validateScheduleItems(null).ok).toBe(false);
  });

  it("空科目は拒否", () => {
    expect(validateScheduleItems([{ period: 1, subject: "  " }]).ok).toBe(false);
  });

  it("時限の範囲外は拒否 (1..12)", () => {
    expect(validateScheduleItems([{ period: 0, subject: "x" }]).ok).toBe(false);
    expect(validateScheduleItems([{ period: 13, subject: "x" }]).ok).toBe(false);
  });

  it("特殊スロット (morning / lunch / afterschool) を受理", () => {
    const r = validateScheduleItems([
      { period: "morning", subject: "朝の会" },
      { period: "lunch", subject: "昼食" },
      { period: "afterschool", subject: "部活" },
    ]);
    expect(r.ok && r.value.map((i) => i.period)).toEqual(["morning", "lunch", "afterschool"]);
  });

  it("未知の文字列 period は拒否", () => {
    expect(validateScheduleItems([{ period: "evening", subject: "x" }]).ok).toBe(false);
    expect(validateScheduleItems([{ period: "0", subject: "x" }]).ok).toBe(false);
  });

  it("特殊スロットと数値が混在しても morning < periods < lunch < afterschool に正規化", () => {
    const r = validateScheduleItems([
      { period: "afterschool", subject: "部活" },
      { period: 2, subject: "数学" },
      { period: "morning", subject: "朝の会" },
      { period: 1, subject: "国語" },
      { period: "lunch", subject: "昼食" },
    ]);
    expect(r.ok && r.value.map((i) => i.period)).toEqual(["morning", 1, 2, "lunch", "afterschool"]);
  });

  it("時限の重複は拒否", () => {
    const r = validateScheduleItems([
      { period: 1, subject: "国語" },
      { period: 1, subject: "数学" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("特殊スロットの重複は拒否", () => {
    const r = validateScheduleItems([
      { period: "lunch", subject: "昼食A" },
      { period: "lunch", subject: "昼食B" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("13 コマ超は拒否", () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ period: i + 1, subject: "x" }));
    expect(validateScheduleItems(items).ok).toBe(false);
  });

  it("科目名 33 文字は拒否", () => {
    expect(validateScheduleItems([{ period: 1, subject: "あ".repeat(33) }]).ok).toBe(false);
  });

  it("空配列は許可 (予定なし = 全削除)", () => {
    expect(validateScheduleItems([])).toEqual({ ok: true, value: [] });
  });

  it("場所 / 対象者を任意で受理（trim・空文字は省略）", () => {
    const r = validateScheduleItems([
      { period: 1, subject: "体育", location: " 体育館 ", targetAudience: "3年生" },
      { period: 2, subject: "数学", location: "", targetAudience: "" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { period: 1, subject: "体育", location: "体育館", targetAudience: "3年生" },
        { period: 2, subject: "数学" },
      ],
    });
  });

  it("場所 / 対象者が長すぎる（51 文字）は拒否", () => {
    expect(validateScheduleItems([{ period: 1, subject: "x", location: "あ".repeat(51) }]).ok).toBe(
      false,
    );
    expect(
      validateScheduleItems([{ period: 1, subject: "x", targetAudience: "あ".repeat(51) }]).ok,
    ).toBe(false);
  });
});

describe("scheduleSlotLabel", () => {
  it("数値時限は `N限`", () => {
    expect(scheduleSlotLabel(1)).toBe("1限");
    expect(scheduleSlotLabel(12)).toBe("12限");
  });
  it("特殊スロットは 朝 / 昼休み / 放課後", () => {
    expect(scheduleSlotLabel("morning")).toBe("朝");
    expect(scheduleSlotLabel("lunch")).toBe("昼休み");
    expect(scheduleSlotLabel("afterschool")).toBe("放課後");
  });
});

describe("scheduleSlotSortKey", () => {
  it("morning < 1 < 12 < lunch < afterschool の順に並ぶ", () => {
    const slots = ["afterschool", 12, "morning", 1, "lunch"] as const;
    const sorted = [...slots].sort((a, b) => scheduleSlotSortKey(a) - scheduleSlotSortKey(b));
    expect(sorted).toEqual(["morning", 1, 12, "lunch", "afterschool"]);
  });
});

describe("SCHEDULE_SLOT_OPTIONS", () => {
  it("morning / 1..12 / lunch / afterschool を順に並べた 15 件", () => {
    expect(SCHEDULE_SLOT_OPTIONS.map((o) => o.value)).toEqual([
      "morning",
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      "lunch",
      "afterschool",
    ]);
    expect(SCHEDULE_SLOT_OPTIONS[0]).toEqual({ value: "morning", label: "朝" });
    expect(SCHEDULE_SLOT_OPTIONS[1]).toEqual({ value: 1, label: "1限" });
  });
});
