import { describe, expect, it } from "vitest";
import { padBlankRows } from "../../lib/editor/prefill-rows";

/**
 * 行の事前生成ヘルパ（{@link padBlankRows}）の検証。盤面の規定枠ぶん空行を最初から並べる土台なので、
 * 「不足分だけ足す / 既存が多ければ切り詰めない / no-op / index の渡し方 / 非破壊」を固定する。
 */
describe("padBlankRows（行の事前生成）", () => {
  it("minRows まで空行を足す（不足分を makeBlank で生成）", () => {
    const rows = [{ v: "a" }];
    const out = padBlankRows(rows, 3, (i) => ({ v: `blank${i}` }));
    expect(out).toEqual([{ v: "a" }, { v: "blank1" }, { v: "blank2" }]);
  });

  it("既存が minRows 以上なら切り詰めずそのまま返す（既存入力を失わない）", () => {
    const rows = [{ v: "a" }, { v: "b" }, { v: "c" }];
    expect(padBlankRows(rows, 2, () => ({ v: "x" }))).toEqual(rows);
    expect(padBlankRows(rows, 3, () => ({ v: "x" }))).toEqual(rows);
  });

  it("minRows<=0 は no-op（事前生成無効＝従来挙動）", () => {
    const rows = [{ v: "a" }];
    expect(padBlankRows(rows, 0, () => ({ v: "x" }))).toEqual(rows);
    expect(padBlankRows([], 0, () => ({ v: "x" }))).toEqual([]);
  });

  it("makeBlank には rows.length 始まりの index が渡る（安定キー / 時限の連番採番に使える）", () => {
    const seen: number[] = [];
    padBlankRows([{ v: "a" }, { v: "b" }], 5, (i) => {
      seen.push(i);
      return { v: "x" };
    });
    expect(seen).toEqual([2, 3, 4]);
  });

  it("元配列を破壊しない（新しい配列を返す）", () => {
    const rows = [{ v: "a" }];
    const out = padBlankRows(rows, 3, () => ({ v: "x" }));
    expect(rows).toHaveLength(1);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(rows);
  });
});
