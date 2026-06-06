import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * EditorBoard (段B) のレイアウト枠を pin する。
 *
 * サイネージ盤面風レイアウト（時間割上段 / 連絡・提出物下段 / 広告・天気プレビュー）の構造を持ち、
 * 渡された header と 3 セクションの編集器ノードをそのまま描画することを検証する。レスポンシブの
 * 出し分け（PC グリッド / スマホ縦積み）は CSS Module のメディアクエリが担うため本テスト対象外
 * （構造 = 見出し + 渡したノード + プレビュー枠の存在だけを保証する）。e2e が依存する見出し
 * 「時間割」「連絡」「提出物」を盤面側で確実に出すことを回帰として固定する。
 */

import { EditorBoard } from "../../app/admin/editor/[classId]/_components/EditorBoard";

describe("EditorBoard", () => {
  it("3 セクションの見出しと渡したノードを盤面に並べ、広告/天気はプレビュー枠で出す", () => {
    render(
      <EditorBoard
        header={<h1>1年A組</h1>}
        schedule={<div>SCHEDULE_EDITOR</div>}
        notices={<div>NOTICE_EDITOR</div>}
        assignments={<div>ASSIGNMENT_EDITOR</div>}
      />,
    );

    // 見出し（e2e が依存）。role の name 文字列マッチは既定で完全一致。
    expect(screen.getByRole("heading", { name: "1年A組", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "時間割" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "連絡" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "提出物" })).toBeTruthy();

    // 渡された編集器ノードがそのまま描画される。
    expect(screen.getByText("SCHEDULE_EDITOR")).toBeTruthy();
    expect(screen.getByText("NOTICE_EDITOR")).toBeTruthy();
    expect(screen.getByText("ASSIGNMENT_EDITOR")).toBeTruthy();

    // 広告・天気は read-only プレビュー枠（編集対象外）として存在する。
    expect(screen.getByRole("heading", { name: "広告" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "天気" })).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "サイネージ表示プレビュー（編集対象外）" }),
    ).toBeTruthy();
  });
});
