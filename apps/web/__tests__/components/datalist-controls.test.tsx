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
 *  4. `params.filters` のうち `selects` に無いキーは**自動で** hidden になる（ページ側の書き忘れ防止）。
 *  5. `selects` が持つキーは自動 hidden にしない（select と二重に送らない）。
 *  6. 同名キーは `hidden` prop が自動温存に優先する（空文字での抑止も含む）。
 */

/** テスト用の ListParams（parseListParams を通して実物と同じ正規化経路で作る）。 */
function makeParams(
  raw: Record<string, string>,
  defaultSort: string,
  sortKeys: string[],
  filterKeys: string[] = ["status"],
) {
  return parseListParams(raw, { sortKeys, defaultSort, filterKeys });
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

describe("DataListControls の filters 自動温存", () => {
  it("selects に無い filters キーは自動で hidden になる（ページ側の書き忘れを構造的に防ぐ）", () => {
    // filterKeys に宣言済みだが selects に出していない条件（タブ / リンクで切替える類）。
    const params = makeParams({ status: "down" }, "", [], ["status"]);
    const { container } = render(<DataListControls basePath="/ops/tv-devices" params={params} />);
    expect(hiddenInputs(container)).toEqual({ status: "down" });
  });

  it("selects が持つキーは自動 hidden にしない（select と二重に送らない）", () => {
    const params = makeParams({ status: "active" }, "", [], ["status"]);
    const { container } = render(
      <DataListControls
        basePath="/ops/advertisers"
        params={params}
        selects={[
          {
            name: "status",
            label: "状態",
            options: [{ value: "active", label: "有効" }],
          },
        ]}
      />,
    );
    // select が name="status" を送るので hidden は出ない（出すと `?status=a&status=b` になる）。
    expect(hiddenInputs(container)).toEqual({});
    expect(container.querySelector('select[name="status"]')).not.toBeNull();
  });

  it("複数 filters のうち selects に無いキーだけを自動 hidden にする", () => {
    const params = makeParams({ school: "s1", state: "down" }, "", [], ["school", "state"]);
    const { container } = render(
      <DataListControls
        basePath="/ops/tv-downtime"
        params={params}
        selects={[
          {
            name: "school",
            label: "学校",
            options: [{ value: "s1", label: "岐南" }],
          },
        ]}
      />,
    );
    expect(hiddenInputs(container)).toEqual({ state: "down" });
  });

  it("同名キーは hidden prop が自動温存に優先する（空文字なら出さない＝あえて落とす）", () => {
    const params = makeParams({ status: "down" }, "", [], ["status"]);
    const suppressed = render(
      <DataListControls basePath="/ops/tv-devices" params={params} hidden={{ status: "" }} />,
    );
    expect(hiddenInputs(suppressed.container)).toEqual({});

    const overridden = render(
      <DataListControls basePath="/ops/tv-devices" params={params} hidden={{ status: "never" }} />,
    );
    expect(hiddenInputs(overridden.container)).toEqual({ status: "never" });
  });

  it("/ops/dashboard の ?axis= が期間絞り込みで消えない（回帰: axis は selects を持たない）", () => {
    // 実ページと同じ解析経路。`/ops/dashboard` は filterKeys:["axis"] を宣言しつつ軸切替を
    // セレクトではなくタブ (<nav> のリンク) で持つため、hidden が無いと絞り込みで axis が消え、
    // 既定の「学校別」に黙って戻っていた。
    const params = parseListParams(
      { axis: "advertiser", from: "2026-07-01", to: "2026-07-24" },
      {
        sortKeys: ["reactions"],
        defaultSort: "reactions",
        defaultDir: "desc",
        filterKeys: ["axis"],
      },
    );
    const { container } = render(
      <DataListControls
        basePath="/ops/dashboard"
        params={params}
        dateRange
        dateRangeLabel="期間"
      />,
    );
    expect(hiddenInputs(container)).toEqual({
      sort: "reactions",
      dir: "desc",
      axis: "advertiser",
    });
  });
});
