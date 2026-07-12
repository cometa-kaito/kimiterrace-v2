import { describe, expect, it } from "vitest";
import { diffCalendarImportReplace } from "../../lib/editor/calendar-import-diff";

/**
 * 置き換え保存の差分計算（{@link diffCalendarImportReplace}）の固定テスト。
 * 「部分ファイルを取り込むと既存行事が気づかず消える」弱点への対策として、保存確認ダイアログが
 * **削除される行事の一覧**を出すための計算なので、removed の取りこぼし（= 沈黙の削除）が無いことを
 * ここで固める。マッチキーは (summary, startDate)（sanitize / 保存前再検証の dedupe と同じ境界）。
 */

type Existing = {
  summary: string | null;
  startDate: string;
  endDate: string | null;
  location: string | null;
};
type Next = { summary: string; startDate: string };

const ex = (summary: string | null, startDate: string): Existing => ({
  summary,
  startDate,
  endDate: null,
  location: null,
});
const nx = (summary: string, startDate: string): Next => ({ summary, startDate });

describe("diffCalendarImportReplace", () => {
  it("キー一致 = kept、プレビューのみ = added、既存のみ = removed に分類する", () => {
    const existing = [
      ex("入学式", "2026-04-08"),
      ex("体育祭", "2026-06-10"),
      ex("文化祭", "2026-10-03"),
    ];
    const next = [nx("入学式", "2026-04-08"), nx("修学旅行", "2026-12-10")];
    const diff = diffCalendarImportReplace(existing, next);
    expect(diff.added.map((e) => e.summary)).toEqual(["修学旅行"]);
    expect(diff.kept).toBe(1);
    // 部分ファイルの取込で消える既存行事が漏れなく removed に出る（本機能の本丸）。
    expect(diff.removed.map((e) => e.summary)).toEqual(["体育祭", "文化祭"]);
    // 総量の整合: added + kept = next.length。
    expect(diff.added.length + diff.kept).toBe(next.length);
  });

  it("既存 0 件（初回取込）は全行 added・removed は空", () => {
    const diff = diffCalendarImportReplace([], [nx("入学式", "2026-04-08")]);
    expect(diff.added).toHaveLength(1);
    expect(diff.kept).toBe(0);
    expect(diff.removed).toEqual([]);
  });

  it("完全一致（同じファイルの再取込）は全行 kept・added / removed は空", () => {
    const existing = [ex("入学式", "2026-04-08"), ex("体育祭", "2026-06-10")];
    const next = [nx("体育祭", "2026-06-10"), nx("入学式", "2026-04-08")];
    const diff = diffCalendarImportReplace(existing, next);
    expect(diff.added).toEqual([]);
    expect(diff.kept).toBe(2);
    expect(diff.removed).toEqual([]);
  });

  it("同名でも startDate が違えば別行事（added と removed の両方に出る）", () => {
    const diff = diffCalendarImportReplace(
      [ex("中間考査", "2026-05-20")],
      [nx("中間考査", "2026-05-21")],
    );
    expect(diff.added.map((e) => e.startDate)).toEqual(["2026-05-21"]);
    expect(diff.removed.map((e) => e.startDate)).toEqual(["2026-05-20"]);
    expect(diff.kept).toBe(0);
  });

  it("summary は trim して比較する（保存時の Zod .trim() 正規化と同じ境界）", () => {
    const diff = diffCalendarImportReplace(
      [ex("体育祭", "2026-06-10")],
      [nx("  体育祭 ", "2026-06-10")],
    );
    expect(diff.kept).toBe(1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it("既存の summary が null（名称なし）でも落とさず removed に出る", () => {
    const diff = diffCalendarImportReplace([ex(null, "2026-04-08")], [nx("入学式", "2026-04-08")]);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.summary).toBeNull();
  });

  it("removed / added は入力順を保つ（表示順は呼び出し側が決める）", () => {
    const existing = [
      ex("c行事", "2026-07-01"),
      ex("a行事", "2026-04-01"),
      ex("b行事", "2026-05-01"),
    ];
    const diff = diffCalendarImportReplace(existing, []);
    expect(diff.removed.map((e) => e.summary)).toEqual(["c行事", "a行事", "b行事"]);
  });

  it("プレビュー側のキー重複は added + kept = next.length を保つ（保存前再検証がエラーにする状態でも概算が壊れない）", () => {
    const existing = [ex("体育祭", "2026-06-10")];
    const next = [
      nx("体育祭", "2026-06-10"),
      nx("体育祭", "2026-06-10"),
      nx("新入生歓迎会", "2026-04-10"),
    ];
    const diff = diffCalendarImportReplace(existing, next);
    expect(diff.kept).toBe(2);
    expect(diff.added).toHaveLength(1);
    expect(diff.added.length + diff.kept).toBe(next.length);
    expect(diff.removed).toEqual([]);
  });
});
