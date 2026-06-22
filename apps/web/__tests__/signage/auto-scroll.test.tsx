import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * {@link AutoScroll}（盤面の縦オートスクロール）の単体テスト。jsdom はレイアウト計測（scrollHeight/clientHeight）が
 * 常に 0・`Element.animate`/`ResizeObserver`/`matchMedia` も未実装なので、本コンポーネントは**距離 0 と判定して静的
 * 描画**する。ここで担保したいのは「環境 API が無くても例外を投げず、子要素を**全件 DOM に残す**」こと
 * （= `toHaveTextContent` 系の盤面テストが緑のままになる前提・[[ref_apps_web_tsx_tests_need_full_suite]]）。
 */

import { AutoScroll } from "../../app/(signage)/signage/[classToken]/_components/AutoScroll";

describe("AutoScroll", () => {
  it("子要素を全件そのまま DOM に描画する（静的フォールバック・切り捨てない）", () => {
    render(
      <AutoScroll>
        <ul>
          <li>記事その1</li>
          <li>記事その2</li>
          <li>記事その3</li>
        </ul>
      </AutoScroll>,
    );
    expect(screen.getByText("記事その1")).toBeInTheDocument();
    expect(screen.getByText("記事その2")).toBeInTheDocument();
    expect(screen.getByText("記事その3")).toBeInTheDocument();
  });

  it("play=false でも子要素を描画し、例外を投げない", () => {
    expect(() =>
      render(
        <AutoScroll play={false}>
          <p>静止コンテンツ</p>
        </AutoScroll>,
      ),
    ).not.toThrow();
    expect(screen.getByText("静止コンテンツ")).toBeInTheDocument();
  });

  it("className はビューポートに付与され、追加のラッパで内容が消えない", () => {
    render(
      <AutoScroll className="custom-viewport">
        <span>中身</span>
      </AutoScroll>,
    );
    expect(screen.getByText("中身")).toBeInTheDocument();
    expect(document.querySelector(".custom-viewport")).not.toBeNull();
  });
});
