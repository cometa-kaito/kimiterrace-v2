import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_DAY_CUTOVER,
  editorDateSegments,
  isSchoolDay,
  nextSchoolDay,
  parseEditorDayCutover,
  planRedirectPath,
  resolveDefaultEditorDate,
} from "../../lib/editor/default-date";

/**
 * エディタの既定対象日（editor-restructure-bulletin-2026-07.md §3.2）の純関数テスト。
 * 「授業日の下校時刻（cutover・既定 16:00）まで＝今日、それ以降と休日＝次の授業日」を固定する。
 * 2026-07-03 は金曜・07-04 は土曜・07-06 は月曜（実カレンダー）。
 */

/** JST の壁時計 `YYYY-MM-DDTHH:MM` を UTC の Date にする（JST = UTC+9・テスト入力用）。 */
function jst(dateTime: string): Date {
  return new Date(`${dateTime}:00+09:00`);
}

describe("parseEditorDayCutover（display_settings の defensive パース）", () => {
  it("value.editorDayCutover の 'HH:MM' を採用する", () => {
    expect(parseEditorDayCutover({ editorDayCutover: "13:30" })).toBe("13:30");
    expect(parseEditorDayCutover({ editorDayCutover: "23:59", signageDesign: "pattern3" })).toBe(
      "23:59",
    );
  });
  it("欠落・形不正・型不正は既定 16:00 に倒す（fail-soft）", () => {
    expect(parseEditorDayCutover(null)).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover({})).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover({ editorDayCutover: 16 })).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover({ editorDayCutover: "9:00" })).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover({ editorDayCutover: "25:00" })).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover({ editorDayCutover: "16:60" })).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover(["16:00"])).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
    expect(parseEditorDayCutover("16:00")).toBe(DEFAULT_EDITOR_DAY_CUTOVER);
  });
});

describe("isSchoolDay / nextSchoolDay（v1 = 土日スキップのみ・祝日非考慮）", () => {
  it("平日は授業日・土日は休日", () => {
    expect(isSchoolDay("2026-07-03")).toBe(true); // 金
    expect(isSchoolDay("2026-07-04")).toBe(false); // 土
    expect(isSchoolDay("2026-07-05")).toBe(false); // 日
    expect(isSchoolDay("2026-07-06")).toBe(true); // 月
  });
  it("不正な日付は false", () => {
    expect(isSchoolDay("2026-02-30")).toBe(false);
    expect(isSchoolDay("not-a-date")).toBe(false);
  });
  it("次の授業日: 平日→翌平日・金/土/日→月曜（previousBusinessDay の前向き版）", () => {
    expect(nextSchoolDay("2026-07-01")).toBe("2026-07-02"); // 水→木
    expect(nextSchoolDay("2026-07-03")).toBe("2026-07-06"); // 金→月
    expect(nextSchoolDay("2026-07-04")).toBe("2026-07-06"); // 土→月
    expect(nextSchoolDay("2026-07-05")).toBe("2026-07-06"); // 日→月
  });
  it("月末・年末をまたぐ", () => {
    expect(nextSchoolDay("2026-07-31")).toBe("2026-08-03"); // 金→月
    expect(nextSchoolDay("2026-12-31")).toBe("2027-01-01"); // 木→金（祝日非考慮＝v1 制約）
  });
  it("不正な日付は null（fail-soft）", () => {
    expect(nextSchoolDay("bogus")).toBe(null);
  });
});

describe("resolveDefaultEditorDate（既定対象日・§3.2）", () => {
  it("授業日の cutover 前は今日", () => {
    expect(resolveDefaultEditorDate(jst("2026-07-03T08:00"), "16:00")).toBe("2026-07-03");
    expect(resolveDefaultEditorDate(jst("2026-07-03T15:59"), "16:00")).toBe("2026-07-03");
  });
  it("授業日の cutover 以降は次の授業日（金 16:00 → 月）", () => {
    expect(resolveDefaultEditorDate(jst("2026-07-03T16:00"), "16:00")).toBe("2026-07-06");
    expect(resolveDefaultEditorDate(jst("2026-07-02T18:30"), "16:00")).toBe("2026-07-03"); // 木夕方→金
  });
  it("休日（土日）は時刻に関わらず次の授業日", () => {
    expect(resolveDefaultEditorDate(jst("2026-07-04T09:00"), "16:00")).toBe("2026-07-06"); // 土朝→月
    expect(resolveDefaultEditorDate(jst("2026-07-05T20:00"), "16:00")).toBe("2026-07-06"); // 日夜→月
  });
  it("学校ごとの cutover 変更が効く（13:30 の学校は 14 時で翌授業日）", () => {
    expect(resolveDefaultEditorDate(jst("2026-07-01T14:00"), "13:30")).toBe("2026-07-02");
    expect(resolveDefaultEditorDate(jst("2026-07-01T13:29"), "13:30")).toBe("2026-07-01");
  });
  it("JST で判定する（UTC 深夜＝JST 朝の取り違えを起こさない）", () => {
    // UTC 2026-07-02 23:00 = JST 2026-07-03 08:00（金・cutover 前）→ 今日=金。
    expect(resolveDefaultEditorDate(new Date("2026-07-02T23:00:00Z"), "16:00")).toBe("2026-07-03");
  });
});

describe("editorDateSegments（対象日セグメントの日付列・§3.1）", () => {
  it("今日を先頭に、翌授業日からの授業日を時系列で並べる（土日スキップ）", () => {
    // 金曜: [金, 月, 火, 水]
    expect(editorDateSegments("2026-07-03")).toEqual([
      "2026-07-03",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });
  it("今日が休日でも先頭に出す（今日の盤面確認用途を殺さない）", () => {
    // 土曜: [土, 月, 火, 水]
    expect(editorDateSegments("2026-07-04")).toEqual([
      "2026-07-04",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });
  it("個数を指定できる", () => {
    expect(editorDateSegments("2026-07-03", 1)).toEqual(["2026-07-03", "2026-07-06"]);
  });
  it("不正な today は単独配列で fail-soft", () => {
    expect(editorDateSegments("bogus")).toEqual(["bogus"]);
  });
});

describe("planRedirectPath（旧 ?plan= の後方互換・§3.3）", () => {
  it("有効な plan は ?date= への redirect 先を返す", () => {
    expect(planRedirectPath("c1", "2026-07-08")).toBe("/app/editor/c1?date=2026-07-08");
  });
  it("欠落・不正・実在しない日付は null（リダイレクトせず既定挙動へ）", () => {
    expect(planRedirectPath("c1", undefined)).toBe(null);
    expect(planRedirectPath("c1", "")).toBe(null);
    expect(planRedirectPath("c1", "2026-02-30")).toBe(null);
    expect(planRedirectPath("c1", "not-a-date")).toBe(null);
  });
});
