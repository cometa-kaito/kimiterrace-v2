import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Pattern3NewsTicker } from "../../app/(signage)/signage/[classToken]/_components/Pattern3NewsTicker";
import type { SignageNewsItem } from "../../lib/signage/news";

/**
 * Pattern3NewsTicker（pattern3 廊下フッタの時事ニュースカード）の単体描画テスト。
 *
 * #1156 で「要約あり優先＋不足時のみ見出し補完」を導入し、表示記事の選別を**サーバ側**（getSignagePattern3News）
 * へ移譲・本コンポーネント側の「summary ありのみ」filter を撤去した。これにより補完運用時は **summary=null の
 * 見出しのみ記事（JST/文科省）** も渡ってくる。本テストは、要約 null を渡されても見出し+発表元を描き本文(ul)を
 * 出さず**例外も投げない**こと（footerSummary に null を渡さないガード）を回帰防止として固定する
 * （jsdom .tsx gap の歴史 [[ref_apps_web_tsx_tests_need_full_suite]]）。jsdom は timer を進めないので index=0 の
 * 静止描画になるが、全記事を DOM 保持する設計なので getByText で全件読める（NewsCarousel と同方針）。
 */

// 表示記事の最小ファクトリ（既定は要約 null の見出しのみ記事。over で上書き）。
const newsItem = (over: Partial<SignageNewsItem>): SignageNewsItem => ({
  id: "x",
  title: "見出しX",
  sourceLabel: "経済産業省",
  url: "https://example.go.jp/x",
  summary: null,
  publishedAt: new Date("2026-06-22T00:00:00Z"),
  ...over,
});

describe("Pattern3NewsTicker", () => {
  it("要約あり記事は見出し・発表元・本文(要約)を描画する", () => {
    const { container } = render(
      <Pattern3NewsTicker
        news={{
          items: [
            newsItem({
              id: "meti",
              title: "経産省の発表",
              sourceLabel: "経済産業省",
              summary: "要約の本文です。",
            }),
          ],
          isStale: false,
        }}
      />,
    );
    expect(screen.getByText("経産省の発表")).toBeInTheDocument();
    expect(screen.getByText("経済産業省")).toBeInTheDocument();
    // 要約(本文)が描画される。文分割(先頭2文化)の細部は footerSummary の責務なので、ここは本文が出ることだけを
    // 分割耐性のある textContent で確認する（複数 li を getByText で個別照合すると broken-up で脆くなるため）。
    expect(container.textContent).toContain("要約の本文です。");
  });

  it("見出しのみ記事(summary=null)は見出し+発表元を描き、本文を出さず例外も投げない（補完時の JST/文科省）", () => {
    expect(() =>
      render(
        <Pattern3NewsTicker
          news={{
            items: [
              newsItem({ id: "jst", title: "JSTの記事", sourceLabel: "JST サイエンスポータル" }),
            ],
            isStale: false,
          }}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByText("JSTの記事")).toBeInTheDocument();
    expect(screen.getByText("JST サイエンスポータル")).toBeInTheDocument();
  });

  it("要約あり/見出しのみが混在しても全件 DOM 描画する（補完運用）", () => {
    render(
      <Pattern3NewsTicker
        news={{
          items: [
            newsItem({ id: "meti", title: "METI見出し", summary: "要約本文。" }),
            newsItem({ id: "jst", title: "JST見出し", summary: null }),
          ],
          isStale: false,
        }}
      />,
    );
    expect(screen.getByText("METI見出し")).toBeInTheDocument();
    expect(screen.getByText("JST見出し")).toBeInTheDocument();
    expect(screen.getByText("要約本文。")).toBeInTheDocument();
  });

  it("記事ゼロは「ニュースを取得できていません」（fail-soft）", () => {
    render(<Pattern3NewsTicker news={{ items: [], isStale: false }} />);
    expect(screen.getByText("ニュースを取得できていません")).toBeInTheDocument();
  });

  it("isStale で「情報が古い可能性」を注記する", () => {
    render(<Pattern3NewsTicker news={{ items: [newsItem({})], isStale: true }} />);
    expect(screen.getByText(/情報が古い可能性/)).toBeInTheDocument();
  });
});
