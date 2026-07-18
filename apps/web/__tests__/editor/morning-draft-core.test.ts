import { describe, expect, it } from "vitest";
import {
  type EditorDayEvent,
  dayEventToNoticeItem,
  dayEventToScheduleItem,
} from "../../lib/editor/day-events";
import { type MorningDraftInput, buildMorningDraft } from "../../lib/editor/morning-draft-core";
import type { NoticeItem } from "../../lib/editor/notice-assignment-core";
import type { ScheduleItem } from "../../lib/editor/schedule-core";
import { seedSchedulesForDate } from "../../lib/editor/weekly-timetable-core";

/**
 * P0「朝ドラフト」合成コア {@link buildMorningDraft} を固定する（設計書 §3.1・D1〜D4）。DB 非依存の純関数
 * ユニット。既存純関数（{@link seedSchedulesForDate} / {@link dayEventToScheduleItem} /
 * {@link dayEventToNoticeItem}）の合成に徹していること、パターン駆動（D3）・空セクション限定・除外キー再現
 * （D4）を検証する。
 */

// 2026-07-13 は月曜（平日）。JST/UTC いずれの暦日でも月曜（seedSchedulesForDate は UTC 暦日で判定）。
const MONDAY = "2026-07-13";
// 2026-07-18 は土曜（休日 = 基本時間割の対象外）。
const SATURDAY = "2026-07-18";

/** 月曜の基本時間割 1 コマ（seed 源）。 */
const MON_TIMETABLE = { "1": [{ subject: "数学", period: 1 }] as ScheduleItem[] };

function ev(overrides: Partial<EditorDayEvent> & { id: string }): EditorDayEvent {
  return {
    summary: "終業式",
    location: null,
    allDay: true,
    timeLabel: null,
    startDate: MONDAY,
    endDate: null,
    ...overrides,
  };
}

/** 既定の空 daily_data（全セクション空）。 */
function emptyExisting(): MorningDraftInput["existing"] {
  return { schedules: [], notices: [], assignments: [] };
}

function input(overrides: Partial<MorningDraftInput>): MorningDraftInput {
  return {
    date: MONDAY,
    pattern: "pattern1",
    existing: emptyExisting(),
    weeklyTimetable: MON_TIMETABLE,
    dayEvents: [],
    ...overrides,
  };
}

describe("buildMorningDraft: 基本時間割 seed（D3 パターン駆動）", () => {
  it("空の平日 + 基本時間割登録 + pattern1: 予定に seed が出る（出所=基本時間割・既存純関数と一致）", () => {
    const draft = buildMorningDraft(input({}));
    // seedSchedulesForDate と同一の変換（再発明しない）。
    const seeded = seedSchedulesForDate(MONDAY, [], MON_TIMETABLE);
    expect(seeded.seeded).toBe(true);
    expect(draft.sections.schedules?.map((e) => e.item)).toEqual(seeded.items);
    expect(draft.sections.schedules?.every((e) => e.provenance === "基本時間割")).toBe(true);
    expect(draft.sections.schedules?.map((e) => e.key)).toEqual(["schedules:timetable:0"]);
    expect(draft.isEmpty).toBe(false);
  });

  it("休日（土曜）は時間割 seed を出さない（seedSchedulesForDate が土日で seeded=false）", () => {
    const draft = buildMorningDraft(input({ date: SATURDAY }));
    expect(draft.sections.schedules).toBeUndefined();
    expect(draft.isEmpty).toBe(true);
  });

  it("基本時間割 null / 対象曜日のテンプレ未登録なら seed を出さない", () => {
    expect(buildMorningDraft(input({ weeklyTimetable: null })).sections.schedules).toBeUndefined();
    // 火曜テンプレしか無い校で月曜を開く → 対象曜日未登録。
    const tueOnly = { "2": [{ subject: "国語", period: 1 }] as ScheduleItem[] };
    expect(
      buildMorningDraft(input({ weeklyTimetable: tueOnly })).sections.schedules,
    ).toBeUndefined();
  });

  it("pattern5（時刻型 scheduleInputVariant=time）は時間割 seed を適用しない（D3・行事のみ）", () => {
    const draft = buildMorningDraft(
      input({ pattern: "pattern5", dayEvents: [ev({ id: "e1", summary: "球技大会" })] }),
    );
    // 時間割由来は無し、行事由来の予定のみ。
    expect(draft.sections.schedules?.map((e) => e.provenance)).toEqual(["年間行事"]);
    expect(draft.sections.schedules?.map((e) => e.key)).toEqual(["schedules:event:e1"]);
  });
});

describe("buildMorningDraft: 行事の合成", () => {
  it("pattern1・空日: 予定は seed + 行事、連絡は行事（両セクションに出る）", () => {
    const e = ev({ id: "e1", summary: "終業式", location: "体育館" });
    const draft = buildMorningDraft(input({ dayEvents: [e] }));

    expect(draft.sections.schedules?.map((x) => x.key)).toEqual([
      "schedules:timetable:0",
      "schedules:event:e1",
    ]);
    // 行事→予定/連絡の写像は既存純関数と一致（再発明しない）。
    const eventSchedule = draft.sections.schedules?.find((x) => x.key === "schedules:event:e1");
    expect(eventSchedule?.item).toEqual(dayEventToScheduleItem(e));
    expect(draft.sections.notices?.map((x) => x.key)).toEqual(["notices:event:e1"]);
    expect(draft.sections.notices?.[0]?.item).toEqual(dayEventToNoticeItem(e));
  });

  it("pattern4（連絡のみ編集）: 予定は合成しない・行事は連絡にだけ出る", () => {
    const draft = buildMorningDraft(input({ pattern: "pattern4", dayEvents: [ev({ id: "e1" })] }));
    expect(draft.sections.schedules).toBeUndefined();
    expect(draft.sections.notices?.map((x) => x.key)).toEqual(["notices:event:e1"]);
  });

  it("pattern2（notice が非編集ブロック）: 行事は予定にだけ出て連絡には出ない", () => {
    const draft = buildMorningDraft(
      input({ pattern: "pattern2", dayEvents: [ev({ id: "e1", summary: "避難訓練" })] }),
    );
    expect(draft.sections.schedules?.map((x) => x.provenance)).toContain("年間行事");
    expect(draft.sections.notices).toBeUndefined();
  });

  it("複数行事は入力順で安定キーを持つ", () => {
    const draft = buildMorningDraft(
      input({
        pattern: "pattern4",
        dayEvents: [ev({ id: "a" }), ev({ id: "b" }), ev({ id: "c" })],
      }),
    );
    expect(draft.sections.notices?.map((x) => x.key)).toEqual([
      "notices:event:a",
      "notices:event:b",
      "notices:event:c",
    ]);
  });
});

describe("buildMorningDraft: 空セクションのみ合成（コピーオンライト・既入力日は触れない）", () => {
  it("既に予定入力ありなら予定は合成しない（連絡が空なら連絡は独立に合成される）", () => {
    const existing: MorningDraftInput["existing"] = {
      schedules: [{ subject: "既存の予定" }] as ScheduleItem[],
      notices: [],
      assignments: [],
    };
    const draft = buildMorningDraft(input({ existing, dayEvents: [ev({ id: "e1" })] }));
    // 予定セクションは触れない（seed も行事も入れない）。
    expect(draft.sections.schedules).toBeUndefined();
    // 連絡セクションは空なので行事から合成される。
    expect(draft.sections.notices?.map((x) => x.key)).toEqual(["notices:event:e1"]);
  });

  it("既に連絡入力ありなら連絡は合成しない（予定が空なら予定は合成される）", () => {
    const existing: MorningDraftInput["existing"] = {
      schedules: [],
      notices: [{ text: "既存の連絡" }] as NoticeItem[],
      assignments: [],
    };
    const draft = buildMorningDraft(input({ existing, dayEvents: [ev({ id: "e1" })] }));
    expect(draft.sections.notices).toBeUndefined();
    expect(draft.sections.schedules?.length).toBeGreaterThan(0);
  });

  it("全セクション入力済みなら何も合成しない（既入力日では何も出ない = 受入基準）", () => {
    const existing: MorningDraftInput["existing"] = {
      schedules: [{ subject: "既存" }] as ScheduleItem[],
      notices: [{ text: "既存" }] as NoticeItem[],
      assignments: [],
    };
    const draft = buildMorningDraft(input({ existing, dayEvents: [ev({ id: "e1" })] }));
    expect(draft.sections.schedules).toBeUndefined();
    expect(draft.sections.notices).toBeUndefined();
    expect(draft.provenance).toEqual([]);
    expect(draft.isEmpty).toBe(true);
  });
});

describe("buildMorningDraft: 除外キー（D4 の再現性）", () => {
  it("指定キーの項目を落とす（除外後の sections / provenance / isEmpty に反映）", () => {
    const full = buildMorningDraft(input({ dayEvents: [ev({ id: "e1" })] }));
    // full: 予定[timetable:0, event:e1] + 連絡[event:e1]。
    const draft = buildMorningDraft(
      input({
        dayEvents: [ev({ id: "e1" })],
        excluded: ["schedules:event:e1", "notices:event:e1"],
      }),
    );
    expect(full.sections.schedules?.map((x) => x.key)).toEqual([
      "schedules:timetable:0",
      "schedules:event:e1",
    ]);
    // 行事由来の予定・連絡を両方除外 → 予定は timetable のみ、連絡は空。
    expect(draft.sections.schedules?.map((x) => x.key)).toEqual(["schedules:timetable:0"]);
    expect(draft.sections.notices).toBeUndefined();
    expect(draft.isEmpty).toBe(false);
  });

  it("全項目を除外すると isEmpty=true・sections 空・provenance 空", () => {
    const draft = buildMorningDraft(input({ excluded: ["schedules:timetable:0"] }));
    expect(draft.sections.schedules).toBeUndefined();
    expect(draft.sections.notices).toBeUndefined();
    expect(draft.provenance).toEqual([]);
    expect(draft.isEmpty).toBe(true);
  });

  it("未知の除外キーは無害（該当なしでそのまま）", () => {
    const draft = buildMorningDraft(input({ excluded: ["schedules:timetable:999", "bogus"] }));
    expect(draft.sections.schedules?.map((x) => x.key)).toEqual(["schedules:timetable:0"]);
  });
});

describe("buildMorningDraft: provenance フラット一覧は sections の射影", () => {
  it("section+key+provenance が sections の並び（予定→連絡）で一致する", () => {
    const draft = buildMorningDraft(input({ dayEvents: [ev({ id: "e1" })] }));
    expect(draft.provenance).toEqual([
      { section: "schedules", key: "schedules:timetable:0", provenance: "基本時間割" },
      { section: "schedules", key: "schedules:event:e1", provenance: "年間行事" },
      { section: "notices", key: "notices:event:e1", provenance: "年間行事" },
    ]);
  });

  it("合成が空なら provenance も空・isEmpty=true（カード非表示の分岐）", () => {
    const draft = buildMorningDraft(input({ date: SATURDAY, weeklyTimetable: null }));
    expect(draft.provenance).toEqual([]);
    expect(draft.isEmpty).toBe(true);
  });
});
