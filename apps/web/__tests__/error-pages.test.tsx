import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../app/error";
import NotFound from "../app/not-found";

/**
 * App Router の特殊ファイル (not-found.tsx / error.tsx) の UI 配線検証。
 * これらが無いと Next 既定の素の英語ページ（アプリシェルも消える）になるため、日本語ブランド面と
 * 復帰導線（ホーム / 再読み込み）が出ることを固定する。
 */

describe("not-found.tsx (404 面)", () => {
  it("日本語の 404 文言とホーム導線 (/admin) を出す", () => {
    render(<NotFound />);
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ページが見つかりません" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ホームに戻る" })).toHaveAttribute("href", "/admin");
  });
});

describe("error.tsx (エラーバウンダリ)", () => {
  it("日本語のエラー文言・再読み込み・ホーム導線を出し、再読み込みで reset を呼ぶ", () => {
    const reset = vi.fn();
    render(
      <ErrorBoundary
        error={Object.assign(new Error("boom"), { digest: "abc123" })}
        reset={reset}
      />,
    );
    expect(screen.getByRole("heading", { name: "問題が発生しました" })).toBeInTheDocument();
    expect(screen.getByText("エラー ID: abc123")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ホームに戻る" })).toHaveAttribute("href", "/admin");

    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("digest が無ければエラー ID 行を出さない", () => {
    render(<ErrorBoundary error={new Error("boom")} reset={vi.fn()} />);
    expect(screen.queryByText(/エラー ID:/)).not.toBeInTheDocument();
  });
});
