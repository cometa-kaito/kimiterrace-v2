import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Breadcrumb } from "../../app/_components/Breadcrumb";

// next/link は jsdom で素の <a> に落とす（他の component テストと同じ規約）。
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("Breadcrumb（管理画面共通パンくず）", () => {
  it("href を持つ中間項目はリンク、末尾項目は現在地（aria-current=page・非リンク）", () => {
    render(
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: "岐南工業高校", href: "/ops/schools/abc" },
          { label: "クラス設定" },
        ]}
      />,
    );

    // 中間 2 項目は <a href> リンク。
    expect(screen.getByRole("link", { name: "学校一覧" })).toHaveAttribute("href", "/ops/schools");
    expect(screen.getByRole("link", { name: "岐南工業高校" })).toHaveAttribute(
      "href",
      "/ops/schools/abc",
    );

    // 末尾（現在地）はリンクにせず aria-current="page"。
    expect(screen.queryByRole("link", { name: "クラス設定" })).toBeNull();
    const current = screen.getByText("クラス設定");
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("nav は aria-label でパンくずと判別でき、項目は順序リスト <ol> で表す", () => {
    const { container } = render(
      <Breadcrumb items={[{ label: "学校一覧", href: "/ops/schools" }, { label: "詳細" }]} />,
    );
    expect(screen.getByRole("navigation", { name: "パンくず" })).toBeInTheDocument();
    // 階層の順序を意味づける <ol>（区切り "/" は装飾なので aria-hidden）。
    expect(container.querySelector("ol")).not.toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("href を持つ末尾項目でも現在地としてリンクにしない（誤って自分自身へのリンクを出さない）", () => {
    render(
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: "詳細", href: "/ops/schools/abc" },
        ]}
      />,
    );
    expect(screen.queryByRole("link", { name: "詳細" })).toBeNull();
    expect(screen.getByText("詳細")).toHaveAttribute("aria-current", "page");
  });

  it("items が空なら何も描画しない", () => {
    const { container } = render(<Breadcrumb items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
