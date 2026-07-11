import type { SchoolCalendarEvent } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_IMPORT_PAGE_PATH,
  DAY_EVENT_LOOKBACK_DAYS,
  type EditorDayEvent,
  dayEventMetaLabel,
  dayEventToNoticeItem,
  dayEventToScheduleItem,
  eventsForEditorDate,
} from "../../lib/editor/day-events";

/**
 * 「この日の行事」（ADR-049 決定 7・PR-D）の純コア {@link eventsForEditorDate}（対象日該当判定・射影）と
 * 予定 / 連絡への確定挿入写像（{@link dayEventToScheduleItem} / {@link dayEventToNoticeItem}）を固定する。
 * DB 非依存（行フィクスチャのみ）。
 */

/** school_calendar_events 行フィクスチャ（判定に関係ない列は固定値）。 */
function row(overrides: Partial<SchoolCalendarEvent> & { id: string }): SchoolCalendarEvent {
  return {
    schoolId: "school-1",
    uid: `uid-${overrides.id}`,
    summary: "体育祭",
    startDate: "2026-07-10",
    endDate: null,
    startAt: null,
    endAt: null,
    allDay: true,
    location: null,
    sourceId: null,
    raw: {},
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    ...overrides,
  };
}

function ev(overrides: Partial<EditorDayEvent>): EditorDayEvent {
  return {
    id: "e1",
    summary: "体育祭",
    location: null,
    allDay: true,
    timeLabel: null,
    startDate: "2026-07-10",
    endDate: null,
    ...overrides,
  };
}

describe("eventsForEditorDate（対象日該当の判定と射影）", () => {
  it("単日行事は startDate = 対象日 のときだけ含む", () => {
    const rows = [
      row({ id: "a", startDate: "2026-07-10" }),
      row({ id: "b", startDate: "2026-07-09" }),
      row({ id: "c", startDate: "2026-07-11" }),
    ];
    expect(eventsForEditorDate(rows, "2026-07-10").map((e) => e.id)).toEqual(["a"]);
  });

  it("複数日行事（startDate ≤ 対象日 ≤ endDate）は期間中の毎日に含む（両端含む）", () => {
    const rows = [row({ id: "trip", startDate: "2026-07-08", endDate: "2026-07-11" })];
    for (const date of ["2026-07-08", "2026-07-09", "2026-07-11"]) {
      expect(eventsForEditorDate(rows, date).map((e) => e.id)).toEqual(["trip"]);
    }
    expect(eventsForEditorDate(rows, "2026-07-07")).toEqual([]);
    expect(eventsForEditorDate(rows, "2026-07-12")).toEqual([]);
  });

  it("summary が NULL / 空白のみの行は除外する（挿入本文を成立させられない）", () => {
    const rows = [
      row({ id: "a", summary: null }),
      row({ id: "b", summary: "   " }),
      row({ id: "c", summary: "  終業式  " }),
    ];
    const out = eventsForEditorDate(rows, "2026-07-10");
    expect(out.map((e) => e.id)).toEqual(["c"]);
    // summary は trim 済みで射影する。
    expect(out[0]?.summary).toBe("終業式");
  });

  it("時刻付き行事（allDay=false・startAt あり）は JST の HH:MM を timeLabel に持つ", () => {
    // 2026-07-10T00:30:00Z = JST 09:30。
    const rows = [
      row({ id: "t", allDay: false, startAt: new Date("2026-07-10T00:30:00Z") }),
      row({ id: "all", allDay: true, startAt: new Date("2026-07-10T00:30:00Z") }),
      row({ id: "no-at", allDay: false, startAt: null }),
    ];
    const out = eventsForEditorDate(rows, "2026-07-10");
    expect(out.find((e) => e.id === "t")?.timeLabel).toBe("09:30");
    // 終日 / 時刻不明は timeLabel なし。
    expect(out.find((e) => e.id === "all")?.timeLabel).toBeNull();
    expect(out.find((e) => e.id === "no-at")?.timeLabel).toBeNull();
  });

  it("該当 0 件なら空配列（パネル非表示の分岐）", () => {
    expect(eventsForEditorDate([], "2026-07-10")).toEqual([]);
    expect(eventsForEditorDate([row({ id: "a", startDate: "2026-04-01" })], "2026-07-10")).toEqual(
      [],
    );
  });

  it("遡及窓は年度水準（複数日行事の当日包含のための startDate レンジ前提）", () => {
    expect(DAY_EVENT_LOOKBACK_DAYS).toBeGreaterThanOrEqual(366);
  });
});

describe("dayEventToScheduleItem（予定へ追加の写像）", () => {
  it("科目 = summary・場所 = location・時刻付きは時刻を自由入力時限（custom）へ", () => {
    expect(
      dayEventToScheduleItem(ev({ summary: "球技大会", location: "体育館", timeLabel: "09:30" })),
    ).toEqual({ subject: "球技大会", location: "体育館", period: { custom: "09:30" } });
  });

  it("終日行事は時限なし（period キーを持たない）・場所なしは location キーを持たない", () => {
    const item = dayEventToScheduleItem(ev({ summary: "終業式" }));
    expect(item).toEqual({ subject: "終業式" });
    expect("period" in item).toBe(false);
    expect("location" in item).toBe(false);
  });

  it("サーバ検証上限へ丸める（summary 32 / location 50）＝長い行事名でも挿入は成立する", () => {
    const item = dayEventToScheduleItem(
      ev({ summary: "あ".repeat(40), location: "い".repeat(60) }),
    );
    expect(item.subject).toBe("あ".repeat(32));
    expect(item.location).toBe("い".repeat(50));
  });
});

describe("dayEventToNoticeItem（連絡へ追加の写像）", () => {
  it("本文 = summary（場所があれば「＠場所」後置）", () => {
    expect(dayEventToNoticeItem(ev({ summary: "三者面談", location: "各教室" }))).toEqual({
      text: "三者面談＠各教室",
    });
    expect(dayEventToNoticeItem(ev({ summary: "終業式" }))).toEqual({ text: "終業式" });
  });

  it("サーバ検証上限（500）へ丸める", () => {
    const out = dayEventToNoticeItem(ev({ summary: "あ".repeat(600) }));
    expect(out.text).toBe("あ".repeat(500));
  });
});

describe("dayEventMetaLabel（行のメタ表示）", () => {
  it("複数日は M/D〜M/D・時刻付きは HH:MM・それ以外は 終日", () => {
    expect(dayEventMetaLabel(ev({ startDate: "2026-07-08", endDate: "2026-07-11" }))).toBe(
      "7/8〜7/11",
    );
    expect(dayEventMetaLabel(ev({ timeLabel: "09:30" }))).toBe("09:30");
    expect(dayEventMetaLabel(ev({}))).toBe("終日");
    // endDate = startDate（単日で endDate が埋まっている iCal 実装差）は期間扱いにしない。
    expect(dayEventMetaLabel(ev({ startDate: "2026-07-10", endDate: "2026-07-10" }))).toBe("終日");
  });
});

describe("PR-C 導線契約", () => {
  it("年間予定表取込ページのパスは /app/editor/calendar-import（PR-C との確定契約）", () => {
    expect(CALENDAR_IMPORT_PAGE_PATH).toBe("/app/editor/calendar-import");
  });
});
