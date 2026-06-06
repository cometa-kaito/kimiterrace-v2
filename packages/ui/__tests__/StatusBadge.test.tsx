import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "../src/StatusBadge";
import { color } from "../src/tokens";

describe("StatusBadge", () => {
  it("ラベルテキストを意味の本体として描画する（色のみに依存しない / NFR05）", () => {
    render(<StatusBadge tone="success">稼働中</StatusBadge>);
    expect(screen.getByText("稼働中")).toBeInTheDocument();
  });

  it("tone に応じた前景色・背景色・枠線を適用する（bg/fg/border の3点とも配線確認）", () => {
    const { container } = render(<StatusBadge tone="danger">無効</StatusBadge>);
    const badge = container.querySelector("span") as HTMLElement;
    expect(badge).not.toBeNull();
    // rgb 正規化される前景色が danger トーンの値であること（色そのものでなくテキストが意味だが、
    // tone 配線が壊れていないことを pin する）。border も含め 3 値すべてを検証する。
    expect(badge.style.color).toBe("rgb(185, 28, 28)"); // fg #b91c1c
    expect(badge.style.background).toBe("rgb(254, 242, 242)"); // bg #fef2f2
    expect(badge.style.border).toBe("1px solid rgb(254, 202, 202)"); // border #fecaca
  });

  it("success / info トーンも個別に正しい前景色を出す（全 tone の取り違え回帰防止）", () => {
    const { container: ok } = render(<StatusBadge tone="success">稼働中</StatusBadge>);
    expect((ok.querySelector("span") as HTMLElement).style.color).toBe("rgb(4, 120, 87)"); // #047857
    const { container: info } = render(<StatusBadge tone="info">情報</StatusBadge>);
    expect((info.querySelector("span") as HTMLElement).style.color).toBe("rgb(29, 78, 216)"); // #1d4ed8
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
