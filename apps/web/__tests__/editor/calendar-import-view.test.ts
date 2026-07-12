import { describe, expect, it } from "vitest";
import {
  INVALID_MONTH_KEY,
  eventDateRangeLabel,
  groupEventsByMonth,
  jpDateLabel,
} from "../../lib/editor/calendar-import-view";

/**
 * 教員 FB「読み取り結果は月順で線で区切って分かり易いように」対応の表示用純ロジック検証。
 * 登録済み一覧（server）と AI プレビュー（client）が共有する単一ソースなので、月境界・年度跨ぎ・
 * 不正日付（編集途中の空欄）・安定ソートをここで固める。
 */

type Row = { name: string; startDate: string };

const byStartDate = (r: Row): string => r.startDate;

describe("groupEventsByMonth", () => {
  it("startDate 昇順に並べ、月ごとにグループ化する（月見出しはゼロ埋めなし）", () => {
    const rows: Row[] = [
      { name: "文化祭", startDate: "2026-10-03" },
      { name: "入学式", startDate: "2026-04-08" },
      { name: "中間考査", startDate: "2026-05-20" },
      { name: "遠足", startDate: "2026-04-20" },
    ];
    const groups = groupEventsByMonth(rows, byStartDate);
    expect(groups.map((g) => g.label)).toEqual(["2026年4月", "2026年5月", "2026年10月"]);
    expect(groups[0]?.items.map((r) => r.name)).toEqual(["入学式", "遠足"]);
    expect(groups[1]?.items.map((r) => r.name)).toEqual(["中間考査"]);
    expect(groups[2]?.items.map((r) => r.name)).toEqual(["文化祭"]);
  });

  it("年度跨ぎ（4月〜翌3月）は暦の年月順のまま年度順になる（翌年 1〜3 月が末尾）", () => {
    const rows: Row[] = [
      { name: "卒業式", startDate: "2027-03-01" },
      { name: "入学式", startDate: "2026-04-08" },
      { name: "修学旅行", startDate: "2026-12-10" },
    ];
    expect(groupEventsByMonth(rows, byStartDate).map((g) => g.monthKey)).toEqual([
      "2026-04",
      "2026-12",
      "2027-03",
    ]);
  });

  it("同日の行は入力順を保つ（安定ソート・React key の入れ替わり事故防止）", () => {
    const rows: Row[] = [
      { name: "開会式", startDate: "2026-05-20" },
      { name: "閉会式", startDate: "2026-05-20" },
    ];
    expect(groupEventsByMonth(rows, byStartDate)[0]?.items.map((r) => r.name)).toEqual([
      "開会式",
      "閉会式",
    ]);
  });

  it("YYYY-MM-DD の形でない行は落とさず末尾の「日付未設定」グループへ（編集途中の空欄）", () => {
    const rows: Row[] = [
      { name: "編集中", startDate: "" },
      { name: "入学式", startDate: "2026-04-08" },
    ];
    const groups = groupEventsByMonth(rows, byStartDate);
    expect(groups.map((g) => g.monthKey)).toEqual(["2026-04", INVALID_MONTH_KEY]);
    expect(groups[1]?.label).toBe("日付未設定");
    expect(groups[1]?.items.map((r) => r.name)).toEqual(["編集中"]);
  });

  it("空配列は空のグループ配列", () => {
    expect(groupEventsByMonth([], byStartDate)).toEqual([]);
  });
});

describe("eventDateRangeLabel", () => {
  it("単日 = M/D(曜)（2026-04-08 は水曜）", () => {
    expect(eventDateRangeLabel("2026-04-08")).toBe("4/8(水)");
    expect(eventDateRangeLabel("2026-04-08", null)).toBe("4/8(水)");
    expect(eventDateRangeLabel("2026-04-08", "")).toBe("4/8(水)");
  });

  it("複数日 = 開始〜終了（曜日付き）", () => {
    expect(eventDateRangeLabel("2026-05-25", "2026-05-28")).toBe("5/25(月)〜5/28(木)");
  });

  it("endDate が startDate と同じなら単日表示", () => {
    expect(eventDateRangeLabel("2026-04-08", "2026-04-08")).toBe("4/8(水)");
  });

  it("不正な日付形は表示で落とさずそのまま返す", () => {
    expect(eventDateRangeLabel("")).toBe("");
    expect(eventDateRangeLabel("2026-04-08", "来週")).toBe("4/8(水)〜来週");
  });
});

describe("jpDateLabel", () => {
  it("年度窓の ISO 生値をゼロ埋めなしの和文表記にする（2026-04-01→2026年4月1日）", () => {
    expect(jpDateLabel("2026-04-01")).toBe("2026年4月1日");
    expect(jpDateLabel("2027-03-31")).toBe("2027年3月31日");
  });

  it("2 桁の月日もゼロ埋めを外す", () => {
    expect(jpDateLabel("2026-12-25")).toBe("2026年12月25日");
  });

  it("不正な日付形は表示で落とさずそのまま返す", () => {
    expect(jpDateLabel("")).toBe("");
    expect(jpDateLabel("2026/04/01")).toBe("2026/04/01");
  });
});
