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

  it("数値時限の重複は拒否", () => {
    const r = validateScheduleItems([
      { period: 1, subject: "国語" },
      { period: 1, subject: "数学" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("特殊スロットの重複は許容する（放課後に複数の予定・入力順を保つ）", () => {
    const r = validateScheduleItems([
      { period: "afterschool", subject: "部活" },
      { period: "afterschool", subject: "三者面談" },
    ]);
    expect(r.ok && r.value.map((i) => [i.period, i.subject])).toEqual([
      ["afterschool", "部活"],
      ["afterschool", "三者面談"],
    ]);
  });

  it("特殊スロットは重複可・数値時限の重複は依然拒否（混在）", () => {
    // 放課後 ×2（許容）+ 1限 ×2（拒否）→ 全体は拒否される。
    const r = validateScheduleItems([
      { period: "afterschool", subject: "部活" },
      { period: "afterschool", subject: "面談" },
      { period: 1, subject: "国語" },
      { period: 1, subject: "数学" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("数値時限 + 特殊スロット重複が並んでも morning < periods < lunch < afterschool に正規化", () => {
    const r = validateScheduleItems([
      { period: "afterschool", subject: "三者面談" },
      { period: 1, subject: "国語" },
      { period: "afterschool", subject: "部活" },
      { period: "morning", subject: "朝の会" },
    ]);
    // afterschool 同士は安定ソートで入力順（三者面談 → 部活）を保つ。
    expect(r.ok && r.value.map((i) => [i.period, i.subject])).toEqual([
      ["morning", "朝の会"],
      [1, "国語"],
      ["afterschool", "三者面談"],
      ["afterschool", "部活"],
    ]);
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

  it("自由入力（その他）を受理する（{ custom } で trim 保存）", () => {
    const r = validateScheduleItems([{ period: { custom: " 補習 " }, subject: "数学" }]);
    expect(r.ok && r.value[0]?.period).toEqual({ custom: "補習" });
  });

  it("自由入力が空（trim 後 0 文字）は拒否", () => {
    expect(validateScheduleItems([{ period: { custom: "   " }, subject: "x" }]).ok).toBe(false);
  });

  it("自由入力が長すぎる（17 文字 > CUSTOM_PERIOD_MAX 16）は拒否", () => {
    expect(validateScheduleItems([{ period: { custom: "あ".repeat(17) }, subject: "x" }]).ok).toBe(
      false,
    );
  });

  it("自由入力の重複は許容する（数値時限の重複だけ拒否・入力順を保つ）", () => {
    const r = validateScheduleItems([
      { period: { custom: "補習" }, subject: "数学" },
      { period: { custom: "補習" }, subject: "英語" },
    ]);
    expect(r.ok && r.value.map((i) => [i.period, i.subject])).toEqual([
      [{ custom: "補習" }, "数学"],
      [{ custom: "補習" }, "英語"],
    ]);
  });

  it("自由入力は標準スロットの後ろに並ぶ（morning < 数値 < lunch < afterschool < その他）", () => {
    const r = validateScheduleItems([
      { period: { custom: "補習" }, subject: "数学" },
      { period: 1, subject: "国語" },
      { period: "afterschool", subject: "部活" },
    ]);
    expect(r.ok && r.value.map((i) => i.subject)).toEqual(["国語", "部活", "数学"]);
  });

  it("時限なし（period 省略）を受理する＝科目のみの予定（period を持たない要素になる）", () => {
    const r = validateScheduleItems([{ subject: "避難訓練" }]);
    expect(r).toEqual({ ok: true, value: [{ subject: "避難訓練" }] });
    // period キーは省かれる（時限ラベルを盤面に出さないため）。
    expect(r.ok && r.value[0] && "period" in r.value[0]).toBe(false);
  });

  it("時限なしは場所 / 対象者を伴っても受理する（科目のみ + メタ）", () => {
    const r = validateScheduleItems([
      { subject: "体育祭", location: "グラウンド", targetAudience: "全校" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [{ subject: "体育祭", location: "グラウンド", targetAudience: "全校" }],
    });
  });

  it("period: null も時限なしとして受理する", () => {
    const r = validateScheduleItems([{ period: null, subject: "集会" }]);
    expect(r).toEqual({ ok: true, value: [{ subject: "集会" }] });
  });

  it("時限なしは複数件を許容する（重複拒否は数値時限のみ）", () => {
    const r = validateScheduleItems([{ subject: "テスト返却" }, { subject: "席替え" }]);
    expect(r.ok && r.value.map((i) => i.subject)).toEqual(["テスト返却", "席替え"]);
  });

  it("時限なしは末尾に並ぶ（数値 < 特殊 < その他 < 時限なし）", () => {
    const r = validateScheduleItems([
      { subject: "学活" },
      { period: 1, subject: "国語" },
      { period: "afterschool", subject: "部活" },
      { period: { custom: "補習" }, subject: "数学" },
    ]);
    expect(r.ok && r.value.map((i) => i.subject)).toEqual(["国語", "部活", "数学", "学活"]);
  });

  it("時限なしでも科目は必須（科目空は拒否）", () => {
    expect(validateScheduleItems([{ subject: "  " }]).ok).toBe(false);
  });

  it("番兵 0 は時限なしではなく従来どおり不正として拒否（0 は wire に載せない設計）", () => {
    expect(validateScheduleItems([{ period: 0, subject: "x" }]).ok).toBe(false);
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
  it("自由入力（その他）はその文字列をそのまま返す", () => {
    expect(scheduleSlotLabel({ custom: "補習" })).toBe("補習");
  });
});

describe("scheduleSlotSortKey", () => {
  it("morning < 1 < 12 < lunch < afterschool の順に並ぶ", () => {
    const slots = ["afterschool", 12, "morning", 1, "lunch"] as const;
    const sorted = [...slots].sort((a, b) => scheduleSlotSortKey(a) - scheduleSlotSortKey(b));
    expect(sorted).toEqual(["morning", 1, 12, "lunch", "afterschool"]);
  });
  it("自由入力（その他）は afterschool より後ろに並ぶ", () => {
    const slots = [{ custom: "補習" }, "afterschool", 1, "morning"] as const;
    const sorted = [...slots].sort((a, b) => scheduleSlotSortKey(a) - scheduleSlotSortKey(b));
    expect(sorted).toEqual(["morning", 1, "afterschool", { custom: "補習" }]);
  });
  it("時限なし（undefined）は最後（自由入力よりさらに後ろ・有限キーで NaN にしない）", () => {
    expect(scheduleSlotSortKey(undefined)).toBeGreaterThan(scheduleSlotSortKey({ custom: "補習" }));
    expect(Number.isFinite(scheduleSlotSortKey(undefined))).toBe(true);
    const slots = [undefined, { custom: "補習" }, 1, "morning"] as const;
    const sorted = [...slots].sort((a, b) => scheduleSlotSortKey(a) - scheduleSlotSortKey(b));
    expect(sorted).toEqual(["morning", 1, { custom: "補習" }, undefined]);
  });
});

describe("SCHEDULE_SLOT_OPTIONS", () => {
  // 数値時限は 1〜6 のみ（2026-06-23 要望: 7〜12 限の構造化選択肢を撤去）。7 限以上は「その他（自由入力）」で。
  it("morning / 1..6 / lunch / afterschool を順に並べた 9 件", () => {
    expect(SCHEDULE_SLOT_OPTIONS.map((o) => o.value)).toEqual([
      "morning",
      1,
      2,
      3,
      4,
      5,
      6,
      "lunch",
      "afterschool",
    ]);
    expect(SCHEDULE_SLOT_OPTIONS[0]).toEqual({ value: "morning", label: "朝" });
    expect(SCHEDULE_SLOT_OPTIONS[1]).toEqual({ value: 1, label: "1限" });
  });

  it("7〜12 限は構造化選択肢から除外（自由入力でのみ入力可・サーバ検証は 1〜12 のまま緩い）", () => {
    const numeric = SCHEDULE_SLOT_OPTIONS.map((o) => o.value).filter(
      (v): v is number => typeof v === "number",
    );
    expect(Math.max(...numeric)).toBe(6);
    expect(numeric).not.toContain(7);
    expect(numeric).not.toContain(12);
    // サーバ検証は 7〜12 を引き続き受理（既存 JSONB データを壊さない）。
    expect(validateScheduleItems([{ period: 7, subject: "補習" }]).ok).toBe(true);
    expect(validateScheduleItems([{ period: 12, subject: "補習" }]).ok).toBe(true);
  });
});
