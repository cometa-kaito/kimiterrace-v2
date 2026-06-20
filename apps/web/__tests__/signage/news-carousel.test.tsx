import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * {@link NewsCarousel}（pattern4 の時事ニュース 1 記事カルーセル）の単体テスト。jsdom は timer/レイアウトを
 * 進めないので index=0 の静止描画になる。担保したいのは「全スライドを**DOM に保持**し（横スライドは translateX
 * で見せ／隠しするだけ）、子の中身が全件読める」こと＝`toHaveTextContent`/`getAllByRole` 系の盤面テストが緑の
 * ままになる前提（[[ref_apps_web_tsx_tests_need_full_suite]]）。複製しないので DOM 重複も出ない。
 */

import { NewsCarousel } from "../../app/(signage)/signage/[classToken]/_components/NewsCarousel";

describe("NewsCarousel", () => {
  it("複数記事を全件 DOM に描画する（切り捨て・複製なし）", () => {
    render(
      <NewsCarousel>
        {[
          <span key="a">記事A本文</span>,
          <span key="b">記事B本文</span>,
          <span key="c">記事C本文</span>,
        ]}
      </NewsCarousel>,
    );
    expect(screen.getByText("記事A本文")).toBeInTheDocument();
    expect(screen.getByText("記事B本文")).toBeInTheDocument();
    expect(screen.getByText("記事C本文")).toBeInTheDocument();
    // 各記事は 1 つずつ（複製しない）。
    expect(screen.getAllByText(/記事[ABC]本文/)).toHaveLength(3);
  });

  it("記事1件のときは送り無し・例外を投げない", () => {
    expect(() =>
      render(<NewsCarousel>{[<span key="only">唯一の記事</span>]}</NewsCarousel>),
    ).not.toThrow();
    expect(screen.getByText("唯一の記事")).toBeInTheDocument();
  });
});
