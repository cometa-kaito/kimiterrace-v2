import { describe, expect, it } from "vitest";
import { expandSimpleRRule, parseICalDate, parseIcs } from "../ical.js";

/**
 * ADR-045: 公開 iCal/ICS パーサ `parseIcs` を防御的サブセットの観点で単体検証する（ネットワーク非依存）。
 * 実 PG / RLS の振る舞いは packages/db の school-calendar.test.ts（実 PG）でカバーする。
 */

function ics(...lines: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
}

describe("parseIcs: 標準 VEVENT", () => {
  it("終日 VEVENT（VALUE=DATE）を allDay=true・startDate でパースする", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:evt-1@example",
        "SUMMARY:始業式",
        "DTSTART;VALUE=DATE:20260408",
        "DTEND;VALUE=DATE:20260409",
        "LOCATION:体育館",
        "END:VEVENT",
      ),
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.uid).toBe("evt-1@example");
    expect(e?.summary).toBe("始業式");
    expect(e?.startDate).toBe("2026-04-08");
    expect(e?.endDate).toBe("2026-04-09");
    expect(e?.allDay).toBe(true);
    expect(e?.startAt).toBeNull();
    expect(e?.location).toBe("体育館");
    // 原文プロパティが raw に保全されている。
    expect(e?.raw.DTSTART).toBe("20260408");
  });

  it("時刻付き VEVENT（UTC Z）を allDay=false・JST 暦日でパースする", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:evt-2",
        "SUMMARY:保護者会",
        // 2026-04-08T01:00:00Z = JST 2026-04-08 10:00（同日）。
        "DTSTART:20260408T010000Z",
        "DTEND:20260408T020000Z",
        "END:VEVENT",
      ),
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.allDay).toBe(false);
    expect(e?.startDate).toBe("2026-04-08");
    expect(e?.startAt).toBeInstanceOf(Date);
    expect(e?.startAt?.toISOString()).toBe("2026-04-08T01:00:00.000Z");
  });

  it("UTC が JST で翌日に跨ぐ場合、startDate は JST 暦日になる", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:evt-late",
        "SUMMARY:夜間行事",
        // 2026-04-08T20:00:00Z = JST 2026-04-09 05:00（翌日）。
        "DTSTART:20260408T200000Z",
        "END:VEVENT",
      ),
    );
    expect(events[0]?.startDate).toBe("2026-04-09");
  });
});

describe("parseIcs: 複数・折り返し・エスケープ", () => {
  it("複数 VEVENT を取り出す", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART;VALUE=DATE:20260408",
        "SUMMARY:行事A",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:b",
        "DTSTART;VALUE=DATE:20260501",
        "SUMMARY:行事B",
        "END:VEVENT",
      ),
    );
    expect(events.map((e) => e.uid)).toEqual(["a", "b"]);
  });

  it("行折り返し（継続行が空白始まり）を連結する", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:fold",
        "DTSTART;VALUE=DATE:20260408",
        "SUMMARY:とても長い行事名の",
        " 続き部分",
        "END:VEVENT",
      ),
    );
    expect(events[0]?.summary).toBe("とても長い行事名の続き部分");
  });

  it("TEXT エスケープ（\\, \\; \\n）をデコードする", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:esc",
        "DTSTART;VALUE=DATE:20260408",
        "SUMMARY:体育祭\\, 雨天順延\\n予備日あり",
        "END:VEVENT",
      ),
    );
    expect(events[0]?.summary).toBe("体育祭, 雨天順延\n予備日あり");
  });
});

describe("parseIcs: fail-soft（壊れ / 空）", () => {
  it("空文字列・非文字列は [] を返す", () => {
    expect(parseIcs("")).toEqual([]);
    // @ts-expect-error 防御的: 非文字列でも throw しない
    expect(parseIcs(undefined)).toEqual([]);
  });

  it("DTSTART が読めない VEVENT は skip し、他の正常 VEVENT は返す", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:broken",
        "SUMMARY:DTSTART 無し",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:ok",
        "DTSTART;VALUE=DATE:20260408",
        "SUMMARY:正常",
        "END:VEVENT",
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBe("ok");
  });

  it("不正な日付（13 月）の VEVENT は skip する", () => {
    const events = parseIcs(
      ics("BEGIN:VEVENT", "UID:bad", "DTSTART;VALUE=DATE:20261308", "END:VEVENT"),
    );
    expect(events).toEqual([]);
  });

  it("UID 欠落でも DTSTART があれば uid=null で返す（呼び出し側が生成）", () => {
    const events = parseIcs(
      ics("BEGIN:VEVENT", "DTSTART;VALUE=DATE:20260408", "SUMMARY:UID無し", "END:VEVENT"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBeNull();
    expect(events[0]?.startDate).toBe("2026-04-08");
  });

  it("VEVENT が無い iCal は [] を返す", () => {
    expect(parseIcs(ics("BEGIN:VTIMEZONE", "TZID:Asia/Tokyo", "END:VTIMEZONE"))).toEqual([]);
  });
});

describe("parseIcs: RRULE 対応サブセット", () => {
  it("FREQ=WEEKLY;COUNT=3 を 3 件（7 日刻み）に展開し uid を一意化する", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:weekly",
        "SUMMARY:週次清掃",
        "DTSTART;VALUE=DATE:20260406",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "END:VEVENT",
      ),
    );
    expect(events.map((e) => e.startDate)).toEqual(["2026-04-06", "2026-04-13", "2026-04-20"]);
    // uid は base に連番付与で (school_id, uid) 一意を満たす。
    expect(events.map((e) => e.uid)).toEqual(["weekly_0", "weekly_1", "weekly_2"]);
  });

  it("FREQ=DAILY;UNTIL=... を UNTIL までの日数に展開する", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:daily",
        "DTSTART;VALUE=DATE:20260408",
        "RRULE:FREQ=DAILY;UNTIL=20260410",
        "END:VEVENT",
      ),
    );
    expect(events.map((e) => e.startDate)).toEqual(["2026-04-08", "2026-04-09", "2026-04-10"]);
  });

  it("対応外 FREQ（MONTHLY）は展開せず元の 1 件のみ", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:monthly",
        "DTSTART;VALUE=DATE:20260408",
        "RRULE:FREQ=MONTHLY;COUNT=12",
        "END:VEVENT",
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.uid).toBe("monthly");
  });

  it("COUNT も UNTIL も無い無限規則は元の 1 件のみ（行を量産しない）", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:infinite",
        "DTSTART;VALUE=DATE:20260408",
        "RRULE:FREQ=DAILY",
        "END:VEVENT",
      ),
    );
    expect(events).toHaveLength(1);
  });

  it("巨大 COUNT は安全上限でクランプする", () => {
    const events = parseIcs(
      ics(
        "BEGIN:VEVENT",
        "UID:huge",
        "DTSTART;VALUE=DATE:20260101",
        "RRULE:FREQ=DAILY;COUNT=100000",
        "END:VEVENT",
      ),
    );
    expect(events.length).toBeLessThanOrEqual(366);
    expect(events.length).toBeGreaterThan(1);
  });
});

describe("parseICalDate", () => {
  it("YYYYMMDD は終日", () => {
    expect(parseICalDate("20260408", true)).toEqual({
      date: "2026-04-08",
      at: null,
      allDay: true,
    });
  });
  it("壊れた値は null", () => {
    expect(parseICalDate("not-a-date", false)).toBeNull();
  });
});

describe("expandSimpleRRule", () => {
  it("対応外は base のみ", () => {
    expect(expandSimpleRRule("2026-04-08", "FREQ=YEARLY;COUNT=5")).toEqual(["2026-04-08"]);
  });
  it("WEEKLY COUNT=2", () => {
    expect(expandSimpleRRule("2026-04-08", "FREQ=WEEKLY;COUNT=2")).toEqual([
      "2026-04-08",
      "2026-04-15",
    ]);
  });
});
