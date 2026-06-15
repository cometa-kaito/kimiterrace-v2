import type { DailyWindowRow } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  computeTodayActiveClasses,
  reduceTodayActiveScopes,
} from "../../lib/school-admin/hub-queries";

/**
 * #48-K3 PR2: computeTodayActiveClasses（本日掲示状態の継承伝搬）の純関数検証。
 * DB 依存の getTodayDailyDataScopes は実 PG が要るため packages/db の RLS テスト
 * (daily-window.test.ts、窓 + RLS 自校限定) に委ね、ここは純関数 2 つ ─ 窓行 → 活性 scope 集約
 * (reduceTodayActiveScopes) と scope → クラス伝搬 (computeTodayActiveClasses) ─ を固める。
 */

const grades = [
  {
    id: "g1",
    name: "1年",
    displayOrder: 0,
    hasClasses: true,
    departmentId: "d1",
    classes: [
      { id: "c1", name: "1組", grade: 1 },
      { id: "c2", name: "2組", grade: 1 },
    ],
  },
  {
    id: "g2",
    name: "2年",
    displayOrder: 0,
    hasClasses: true,
    departmentId: "d2",
    classes: [{ id: "c3", name: "A組", grade: 2 }],
  },
];

describe("computeTodayActiveClasses（本日状態の継承伝搬）", () => {
  it("class scope は当該クラスのみ active", () => {
    expect(
      computeTodayActiveClasses(
        { school: false, departmentIds: [], gradeIds: [], classIds: ["c1"] },
        grades,
      ),
    ).toEqual({ c1: true, c2: false, c3: false });
  });

  it("grade scope は配下クラスを active", () => {
    expect(
      computeTodayActiveClasses(
        { school: false, departmentIds: [], gradeIds: ["g1"], classIds: [] },
        grades,
      ),
    ).toEqual({ c1: true, c2: true, c3: false });
  });

  it("department scope は配下学年のクラスを active", () => {
    expect(
      computeTodayActiveClasses(
        { school: false, departmentIds: ["d2"], gradeIds: [], classIds: [] },
        grades,
      ),
    ).toEqual({ c1: false, c2: false, c3: true });
  });

  it("school scope は全クラス active", () => {
    expect(
      computeTodayActiveClasses(
        { school: true, departmentIds: [], gradeIds: [], classIds: [] },
        grades,
      ),
    ).toEqual({ c1: true, c2: true, c3: true });
  });
});

/**
 * #48-K3: reduceTodayActiveScopes（サイネージ実表示に整合した「今日掲示中の中身を持つ scope」集約）。
 * getDailyWindowRows が返す遡及窓行を、サイネージと同じ活性判定 (schedules=当日のみ /
 * notices=表示日数 / assignments=期限+猶予) で集約することを検証する。日付境界・多日反映が要点。
 */

// 固定の基準日 (JST 想定)。getDailyWindowRows は SQL で window を切るため、ここでは窓内に入った行のみ渡る。
const TODAY = "2026-06-14";
const YESTERDAY = "2026-06-13";
const FIVE_DAYS_AGO = "2026-06-09";
const TWELVE_DAYS_AGO = "2026-06-02";

function wrow(scope: DailyWindowRow["scope"], parts: Partial<DailyWindowRow> = {}): DailyWindowRow {
  return {
    scope,
    gradeId: parts.gradeId ?? null,
    departmentId: parts.departmentId ?? null,
    classId: parts.classId ?? null,
    date: parts.date ?? TODAY,
    today: parts.today ?? TODAY,
    schedules: parts.schedules ?? [],
    notices: parts.notices ?? [],
    assignments: parts.assignments ?? [],
  };
}

describe("reduceTodayActiveScopes（窓行 → 今日掲示中の scope 集約）", () => {
  it("空行は何も active にしない", () => {
    expect(reduceTodayActiveScopes([])).toEqual({
      school: false,
      departmentIds: [],
      gradeIds: [],
      classIds: [],
    });
  });

  it("当日行の予定(schedules)は active、過去日の予定は無視 (schedules は当日のみ)", () => {
    expect(
      reduceTodayActiveScopes([
        wrow("class", { classId: "c1", date: TODAY, schedules: [{ period: 1, subject: "数学" }] }),
        wrow("class", {
          classId: "c2",
          date: YESTERDAY,
          schedules: [{ period: 1, subject: "国語" }],
        }),
      ]),
    ).toEqual({ school: false, departmentIds: [], gradeIds: [], classIds: ["c1"] });
  });

  it("昨日入れた複数日連絡(displayDays>1)が今日も active になる (旧実装の過小表示を解消)", () => {
    expect(
      reduceTodayActiveScopes([
        wrow("class", {
          classId: "c1",
          date: YESTERDAY,
          notices: [{ text: "三者面談のお知らせ", displayDays: 3 }],
        }),
      ]),
    ).toEqual({ school: false, departmentIds: [], gradeIds: [], classIds: ["c1"] });
  });

  it("昨日入れた当日のみ連絡(displayDays 既定 1)は今日は active でない", () => {
    expect(
      reduceTodayActiveScopes([
        wrow("class", { classId: "c1", date: YESTERDAY, notices: [{ text: "昨日だけの連絡" }] }),
      ]),
    ).toEqual({ school: false, departmentIds: [], gradeIds: [], classIds: [] });
  });

  it("期限内の提出物(今日の行なし)は active、期限+猶予を過ぎた提出物は active でない", () => {
    expect(
      reduceTodayActiveScopes([
        // 期限 = 今日 → 活性 (期限 + 2 日まで表示)。
        wrow("class", {
          classId: "c1",
          date: FIVE_DAYS_AGO,
          assignments: [{ deadline: TODAY, subject: "数学", task: "p10" }],
        }),
        // 期限 = 12 日前 → 期限 + 2 日 (10 日前) を過ぎており非活性。
        wrow("class", {
          classId: "c2",
          date: TWELVE_DAYS_AGO,
          assignments: [{ deadline: TWELVE_DAYS_AGO, subject: "国語", task: "p3" }],
        }),
      ]),
    ).toEqual({ school: false, departmentIds: [], gradeIds: [], classIds: ["c1"] });
  });

  it("空セクションだけの当日行は active でない (中身なし)", () => {
    expect(reduceTodayActiveScopes([wrow("class", { classId: "c1", date: TODAY })])).toEqual({
      school: false,
      departmentIds: [],
      gradeIds: [],
      classIds: [],
    });
  });

  it("scope ごとに正しいバケツへ集約する (school / department / grade / class)", () => {
    const notice = [{ text: "連絡" }];
    expect(
      reduceTodayActiveScopes([
        wrow("school", { date: TODAY, notices: notice }),
        wrow("department", { departmentId: "d1", date: TODAY, notices: notice }),
        wrow("grade", { gradeId: "g1", date: TODAY, notices: notice }),
        wrow("class", { classId: "c1", date: TODAY, notices: notice }),
        // 非活性行 (空) は集約されない。
        wrow("grade", { gradeId: "g2", date: TODAY }),
      ]),
    ).toEqual({
      school: true,
      departmentIds: ["d1"],
      gradeIds: ["g1"],
      classIds: ["c1"],
    });
  });
});
