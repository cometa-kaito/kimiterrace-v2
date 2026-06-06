import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "../src/StatusBadge";
import { color } from "../src/tokens";

describe("StatusBadge", () => {
  it("ラベルテキストを意味の本体として描画する（色のみに依存しない / NFR05）", () => {
    render(<StatusBadge tone="success">稼働中</StatusBadge>);
    expect(screen.getByText("稼働中")).toBeInTheDocument();
  });

  it("tone に応じた前景色を適用する", () => {
    const { container } = render(<StatusBadge tone="danger">無効</StatusBadge>);
    const badge = container.querySelector("span");
    expect(badge).not.toBeNull();
    // rgb 正規化される前景色が danger トーンの値であること（色そのものでなくテキストが意味だが、
    // tone 配線が壊れていないことを pin する）。
    expect((badge as HTMLElement).style.color).toBe("rgb(185, 28, 28)"); // #b91c1c
  });

  it("アイコンは装飾（aria-hidden）でテキストを置き換えない", () => {
    render(
      <StatusBadge tone="warning" icon="⚠">
        応答なし
      </StatusBadge>,
    );
    const icon = screen.getByText("⚠");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    // ラベルは別途読み上げ可能なテキストとして存在する。
    expect(screen.getByText("応答なし")).toBeInTheDocument();
  });

  it("icon 未指定なら装飾グリフを描画しない", () => {
    const { container } = render(<StatusBadge>下書き</StatusBadge>);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("既定 tone は neutral", () => {
    const { container } = render(<StatusBadge>未設定</StatusBadge>);
    const badge = container.querySelector("span") as HTMLElement;
    expect(badge.style.background).toBe("rgb(243, 244, 246)"); // color.neutralBg #f3f4f6
    // tokens 由来であることを明示（ハードコード回帰防止）。
    expect(color.neutralBg).toBe("#f3f4f6");
  });
});
