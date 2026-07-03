import { describe, expect, it } from "vitest";

/**
 * 週次ベース時間割（F5）の純粋ロジック `weekly-timetable-core` の単体テスト。曜日キー判定・検証・曜日取り出し・
 * コピーオンライト seed 判定を決定的に固定する。暦アンカー: 2026-06-01 は月曜。
 */

import {
  seedSchedulesForDate,
  timetableForWeekday,
  validateWeeklyTimetable,
  weekdayKeyOfDate,
} from "../../lib/editor/weekly-timetable-core";

describe("weekdayKeyOfDate", () => {
  it("平日は '1'..'5'（月〜金）、土日・不正は null", () => {
    expect(weekdayKeyOfDate("2026-06-01")).toBe("1"); // 月
    expect(weekdayKeyOfDate("2026-06-05")).toBe("5"); // 金
    expect(weekdayKeyOfDate("2026-06-06")).toBeNull(); // 土
    expect(weekdayKeyOfDate("2026-06-07")).toBeNull(); // 日
    expect(weekdayKeyOfDate("bad")).toBeNull();
  });
});

describe("validateWeeklyTimetable", () => {
  it("妥当な曜日別マップを正規化して通す（空曜日はキーごと落とす）", () => {
    const raw = {
      "1": [{ period: 1, subject: "数学" }],
      "3": [{ period: 2, subject: "国語" }],
      "5": [], // 空 → 落とす
    };
    const v = validateWeeklyTimetable(raw);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toEqual({
        "1": [{ period: 1, subject: "数学" }],
        "3": [{ period: 2, subject: "国語" }],
      });
      expect(v.value["5"]).toBeUndefined();
    }
  });

  it("曜日キーが 1〜5 以外は拒否", () => {
    expect(validateWeeklyTimetable({ "6": [{ period: 1, subject: "数学" }] }).ok).toBe(false);
    expect(validateWeeklyTimetable({ mon: [{ period: 1, subject: "数学" }] }).ok).toBe(false);
  });

  it("各曜日は日次予定と同じ検証（時限重複・科目長）を通す", () => {
    // 時限重複は拒否。
    expect(
      validateWeeklyTimetable({
        "1": [
          { period: 1, subject: "数学" },
          { period: 1, subject: "国語" },
        ],
      }).ok,
    ).toBe(false);
    // 科目空は拒否。
    expect(validateWeeklyTimetable({ "1": [{ period: 1, subject: "" }] }).ok).toBe(false);
  });

  it("オブジェクト以外（配列・文字列・null）は拒否", () => {
    expect(validateWeeklyTimetable([]).ok).toBe(false);
    expect(validateWeeklyTimetable("x").ok).toBe(false);
    expect(validateWeeklyTimetable(null).ok).toBe(false);
  });

  it("空オブジェクトは ok（テンプレ未登録）", () => {
    const v = validateWeeklyTimetable({});
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value).toEqual({});
    }
  });
});

describe("timetableForWeekday", () => {
  it("該当曜日の配列を返す（無ければ空）", () => {
    const tt = { "1": [{ period: 1, subject: "数学" }] };
    expect(timetableForWeekday(tt, "1")).toEqual([{ period: 1, subject: "数学" }]);
    expect(timetableForWeekday(tt, "2")).toEqual([]);
  });
});

describe("seedSchedulesForDate（コピーオンライト seed 判定）", () => {
  const MON = [{ period: 1, subject: "数学" }];
  const tt = { "1": MON };

  it("空 かつ 平日 かつ テンプレあり → その曜日を seed（seeded: true）", () => {
    expect(seedSchedulesForDate("2026-06-01", [], tt)).toEqual({ items: MON, seeded: true });
  });

  it("既に入力がある日は seed しない（既存 items を保持）", () => {
    const existing = [{ period: 2, subject: "体育" }];
    expect(seedSchedulesForDate("2026-06-01", existing, tt)).toEqual({
      items: existing,
      seeded: false,
    });
  });

  it("土日は seed しない", () => {
    expect(seedSchedulesForDate("2026-06-06", [], tt)).toEqual({ items: [], seeded: false }); // 土
    expect(seedSchedulesForDate("2026-06-07", [], tt)).toEqual({ items: [], seeded: false }); // 日
  });

  it("平日でもその曜日のテンプレが無ければ seed しない", () => {
    expect(seedSchedulesForDate("2026-06-02", [], tt)).toEqual({ items: [], seeded: false }); // 火（テンプレなし）
    expect(seedSchedulesForDate("2026-06-02", [], {})).toEqual({ items: [], seeded: false }); // テンプレ未登録
  });

  it("不正な日付文字列は seed しない（防御的）", () => {
    expect(seedSchedulesForDate("bad", [], tt)).toEqual({ items: [], seeded: false });
  });
});
