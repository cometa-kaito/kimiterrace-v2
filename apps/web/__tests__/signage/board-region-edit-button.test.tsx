import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoardRegionEditButton,
  type EditRegion,
} from "../../app/(signage)/signage/[classToken]/_components/BoardRegionEditButton";
import {
  SIGNAGE_BLOCK_META,
  type SignageBlockKind,
  blockLabel,
} from "../../lib/signage/pattern-blocks";

/**
 * ジャンプチップ（`BoardRegionEditButton`）の**既定ラベル（fallback `REGION_LABEL`）ドリフトガード**
 * （#1222 Reviewer Low-3）。
 *
 * 通常経路（`regionEditProps`）は必ず `label` を明示して渡すため fallback は使われないが、fallback 表は
 * ラベルの「第 4 の複製源」になりうる。ここで **fallback = 共通ラベル（`SIGNAGE_BLOCK_META.label` =
 * `blockLabel` の既定値）** をブロック対応ごとに機械照合し、盤面 region 名・エディタ見出し・チップの
 * 単一ソース（blockLabel §6.2）から fallback が静かにズレるのを防ぐ。
 */

/** 編集領域 → 表示ブロックの対応（region-anchor / PATTERN_BLOCKS の語彙対応）。 */
const REGION_TO_BLOCK: Record<EditRegion, SignageBlockKind> = {
  schedules: "schedule",
  notices: "notice",
  assignments: "assignment",
  visitors: "visitor",
  callouts: "callout",
};

afterEach(cleanup);

describe("BoardRegionEditButton の既定ラベル（fallback）", () => {
  it.each(
    Object.entries(REGION_TO_BLOCK) as [EditRegion, SignageBlockKind][],
  )("%s: label 未指定の fallback は共通ラベル（blockLabel の既定 = SIGNAGE_BLOCK_META）と一致する", (region, block) => {
    render(
      <BoardRegionEditButton region={region} editRegions={{ active: null, onRegion: () => {} }} />,
    );
    // fallback のアクセシブル名「○○を編集」が共通ラベルと一致（＝pattern 上書きの無い全パターンで
    // regionEditProps の明示 label と同値。ズレたらここで落ちる）。
    expect(
      screen.getByRole("button", { name: `${SIGNAGE_BLOCK_META[block].label}を編集` }),
    ).toBeTruthy();
  });

  it("label 明示（パターン別上書き）が fallback より優先される（pattern5 の例）", () => {
    render(
      <BoardRegionEditButton
        region="notices"
        label={blockLabel("pattern5", "notice")}
        editRegions={{ active: null, onRegion: () => {} }}
      />,
    );
    expect(screen.getByRole("button", { name: "お知らせを編集" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "連絡を編集" })).toBeNull();
  });
});
