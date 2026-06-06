import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../src/EmptyState";

describe("EmptyState", () => {
  it("title を描画し role=status で空状態を支援技術に伝える", () => {
    render(<EmptyState title="まだコンテンツがありません" />);
    expect(screen.getByText("まだコンテンツがありません")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("description は指定時のみ描画する", () => {
    const { rerender } = render(<EmptyState title="空です" />);
    expect(screen.queryByText("補足説明")).toBeNull();
    rerender(<EmptyState title="空です" description="補足説明" />);
    expect(screen.getByText("補足説明")).toBeInTheDocument();
  });

  it("action（次の一手）は指定時のみ描画する＝行き止まり防止に使える", () => {
    const { rerender } = render(<EmptyState title="空です" />);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<EmptyState title="空です" action={<a href="/new">作成する</a>} />);
    expect(screen.getByRole("link", { name: "作成する" })).toHaveAttribute("href", "/new");
  });
});
