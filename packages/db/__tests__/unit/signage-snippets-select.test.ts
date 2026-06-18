import { describe, expect, it } from "vitest";
import {
  type SignageSnippet,
  dayOfYearUTC,
  selectSnippetForDate,
} from "../../src/queries/signage-snippets.js";
import { SIGNAGE_SNIPPET_SEEDS, validateSnippetSeeds } from "../../src/seed-signage-snippets.js";

/**
 * サイネージ静的コンテンツの **決定論ローテ純関数**の単体検証（DB 非依存）。
 * 検証の核: 同じ日付は必ず同じ 1 件（端末間一致）/ on_this_day は MM-DD 一致 / 該当無し・空配列は null。
 */

/** テスト用の最小行を組む（id でソート安定性を効かせる）。 */
function snip(
  over: Partial<SignageSnippet> & Pick<SignageSnippet, "id" | "category">,
): SignageSnippet {
  return {
    body: "body",
    reading: null,
    meaning: null,
    attribution: null,
    monthDay: null,
    active: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    createdBy: null,
    updatedBy: null,
    ...over,
  };
}

describe("dayOfYearUTC", () => {
  it("1/1 は 1、12/31 は 365（非うるう年）", () => {
    expect(dayOfYearUTC(new Date(Date.UTC(2026, 0, 1, 12)))).toBe(1);
    expect(dayOfYearUTC(new Date(Date.UTC(2026, 11, 31, 12)))).toBe(365);
  });

  it("うるう年（2024）は 12/31 が 366", () => {
    expect(dayOfYearUTC(new Date(Date.UTC(2024, 11, 31, 12)))).toBe(366);
  });

  it("時刻成分（UTC 暦日が同じ）に依らず同値", () => {
    expect(dayOfYearUTC(new Date(Date.UTC(2026, 5, 18, 0)))).toBe(
      dayOfYearUTC(new Date(Date.UTC(2026, 5, 18, 23))),
    );
  });
});

describe("selectSnippetForDate（ローテ系 quote/idiom/word）", () => {
  const pool: SignageSnippet[] = [
    snip({ id: "a", category: "quote", body: "Q-A" }),
    snip({ id: "b", category: "quote", body: "Q-B" }),
    snip({ id: "c", category: "quote", body: "Q-C" }),
    // 別カテゴリは混ざっていても無視される。
    snip({ id: "z", category: "idiom", body: "I-Z" }),
  ];

  it("空配列 / 該当カテゴリ 0 件は null", () => {
    expect(selectSnippetForDate([], new Date(Date.UTC(2026, 0, 1)), "quote")).toBeNull();
    expect(selectSnippetForDate(pool, new Date(Date.UTC(2026, 0, 1)), "word")).toBeNull();
  });

  it("同じ日付・同じ items なら必ず同じ 1 件（決定論・端末間一致）", () => {
    const date = new Date(Date.UTC(2026, 5, 18, 12));
    const first = selectSnippetForDate(pool, date, "quote");
    for (let i = 0; i < 5; i++) {
      expect(selectSnippetForDate(pool, date, "quote")?.id).toBe(first?.id);
    }
  });

  it("day-of-year % 件数 で選ぶ（id 昇順 a,b,c の 3 件）", () => {
    // doy=1 → 1%3=1 → 'b'、doy=2 → 2%3=2 → 'c'、doy=3 → 3%3=0 → 'a'。
    expect(selectSnippetForDate(pool, new Date(Date.UTC(2026, 0, 1, 12)), "quote")?.id).toBe("b");
    expect(selectSnippetForDate(pool, new Date(Date.UTC(2026, 0, 2, 12)), "quote")?.id).toBe("c");
    expect(selectSnippetForDate(pool, new Date(Date.UTC(2026, 0, 3, 12)), "quote")?.id).toBe("a");
  });

  it("items の順序が入れ替わっても結果は同じ（id 昇順で安定ソート）", () => {
    const date = new Date(Date.UTC(2026, 5, 18, 12));
    const shuffled = [pool[2], pool[0], pool[3], pool[1]];
    expect(selectSnippetForDate(shuffled, date, "quote")?.id).toBe(
      selectSnippetForDate(pool, date, "quote")?.id,
    );
  });
});

describe("selectSnippetForDate（on_this_day）", () => {
  const items: SignageSnippet[] = [
    snip({ id: "d1", category: "on_this_day", body: "元日", monthDay: "01-01" }),
    snip({ id: "d2", category: "on_this_day", body: "こどもの日", monthDay: "05-05" }),
    // 同じ MM-DD が複数あるケース（決定論で 1 件に絞れること）。
    snip({ id: "d3a", category: "on_this_day", body: "記念日A", monthDay: "05-05" }),
  ];

  it("当日 MM-DD に一致する行から選ぶ", () => {
    expect(
      selectSnippetForDate(items, new Date(Date.UTC(2026, 0, 1, 12)), "on_this_day")?.body,
    ).toBe("元日");
  });

  it("一致が無い日は null（fail-soft）", () => {
    expect(
      selectSnippetForDate(items, new Date(Date.UTC(2026, 2, 14, 12)), "on_this_day"),
    ).toBeNull();
  });

  it("同一 MM-DD が複数でも決定論で同じ 1 件（doy % 一致件数）", () => {
    const date = new Date(Date.UTC(2026, 4, 5, 12)); // 05-05
    const first = selectSnippetForDate(items, date, "on_this_day");
    expect(first).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      expect(selectSnippetForDate(items, date, "on_this_day")?.id).toBe(first?.id);
    }
  });
});

describe("SIGNAGE_SNIPPET_SEEDS（シードデータ）", () => {
  it("自己整合（body 非空 / (category, body) 一意 / on_this_day の MM-DD）", () => {
    expect(() => validateSnippetSeeds(SIGNAGE_SNIPPET_SEEDS)).not.toThrow();
  });

  it("各カテゴリに最低 1 件あり（ローテ・on_this_day が成立する）", () => {
    for (const cat of ["quote", "idiom", "word", "on_this_day"] as const) {
      const count = SIGNAGE_SNIPPET_SEEDS.filter((s) => s.category === cat).length;
      expect(count, `category=${cat}`).toBeGreaterThan(0);
    }
  });

  it("on_this_day のみ monthDay を持ち、他カテゴリは null", () => {
    for (const s of SIGNAGE_SNIPPET_SEEDS) {
      if (s.category === "on_this_day") {
        expect(s.monthDay).toMatch(/^\d{2}-\d{2}$/);
      } else {
        expect(s.monthDay).toBeNull();
      }
    }
  });

  it("validateSnippetSeeds は (category, body) 重複を弾く", () => {
    expect(() =>
      validateSnippetSeeds([
        {
          category: "quote",
          body: "X",
          reading: null,
          meaning: null,
          attribution: null,
          monthDay: null,
        },
        {
          category: "quote",
          body: "X",
          reading: null,
          meaning: null,
          attribution: null,
          monthDay: null,
        },
      ]),
    ).toThrow();
  });

  it("validateSnippetSeeds は on_this_day の monthDay 欠落を弾く", () => {
    expect(() =>
      validateSnippetSeeds([
        {
          category: "on_this_day",
          body: "記念日",
          reading: null,
          meaning: null,
          attribution: null,
          monthDay: null,
        },
      ]),
    ).toThrow();
  });
});
