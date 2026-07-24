import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataListControls } from "../../app/_components/datalist/DataListControls";
import { type ListParams, parseListParams } from "../../app/_components/datalist/list-params";

/**
 * UIUX-03: 共通フィルタバー `DataListControls` の **hidden 温存**を pin する。
 *
 * 本コンポーネントは admin 一覧 14 ページが共有する chokepoint で、`<form method="get">` の送信は
 * URL を丸ごと置き換える。したがって「フォームに含めない URL 条件」は hidden で温存しないと
 * 絞り込みのたびに黙って消える。そこが壊れると各ページで**症状が出ずに条件だけ失われる**ため、
 * 描画レベルで固定する:
 *
 *  1. ソート UI を持つ一覧 (`sort` 非空) では `sort`/`dir` を hidden で温存する（既存 13 ページの前提）。
 *  2. ソート UI を持たない一覧 (`sortKeys` 空 → `sort` 空) では `sort`/`dir` を URL に出さない。
 *  3. `hidden` prop のキーは hidden input になり、空文字の値は出さない（空パラメータで URL を汚さない）。
 */

/** テスト用の ListParams（parseListParams を通して実物と同じ正規化経路で作る）。 */
function makeParams(raw: Record<string, string>, defaultSort: string, sortKeys: string[]) {
  return parseListParams(raw, { sortKeys, defaultSort, filterKeys: ["status"] });
}

function hiddenInputs(container: HTMLElement): Record<string, string> {
  const found: Record<string, string> = {};
  for (const el of container.querySelectorAll('input[type="hidden"]')) {
    found[el.getAttribute("name") ?? ""] = el.getAttribute("value") ?? "";
  }
  return found;
}

describe("DataListControls の hidden 温存", () => {
  it("ソート可能な一覧では sort/dir を hidden で温存する（既存 13 ページの挙動）", () => {
    const params = makeParams({ sort: "name", dir: "asc" }, "prefecture", ["name", "prefecture"]);
    const { container } = render(<DataListControls basePath="/ops/schools" params={params} />);
    expect(hiddenInputs(container)).toEqual({ sort: "name", dir: "asc" });
  });

  it("ソート UI を持たない一覧（sortKeys 空）では sort/dir を出さない", () => {
    const params = makeParams({}, "", []);
    const { container } = render(<DataListControls basePath="/ops/tv-devices" params={params} />);
    expect(hiddenInputs(container)).toEqual({});
  });

  it("hidden prop のキーは hidden input になり、空文字の値は出さない", () => {
    const params = makeParams({}, "", []);
    const { container } = render(
      <DataListControls
        basePath="/ops/tv-devices"
        params={params}
        hidden={{ status: "down", empty: "" }}
      />,
    );
    const found = hiddenInputs(container);
    expect(found).toEqual({ status: "down" });
    expect(found.empty).toBeUndefined();
  });

  it("sort と hidden は併存する（ソート可能な一覧でもフォーム外条件を落とさない）", () => {
    const params: ListParams = makeParams({ sort: "name", dir: "desc" }, "prefecture", ["name"]);
    const { container } = render(
      <DataListControls basePath="/ops/schools" params={params} hidden={{ status: "down" }} />,
    );
    expect(hiddenInputs(container)).toEqual({ sort: "name", dir: "desc", status: "down" });
  });
});
