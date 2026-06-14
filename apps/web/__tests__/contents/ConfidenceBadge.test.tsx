import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfidenceBadge } from "../../app/app/contents/_components/ConfidenceBadge";

describe("ConfidenceBadge (F04.3 確信度フラグ)", () => {
  it("score < 0.7 で「⚠️ 要確認」バッジを表示", () => {
    render(<ConfidenceBadge score={0.5} />);
    expect(screen.getByText(/要確認/)).toBeInTheDocument();
  });

  it("根拠 (evidence) があれば併記する", () => {
    render(<ConfidenceBadge score={0.4} evidence="抽出元: 4 行目「集合は8時」" />);
    expect(screen.getByText(/根拠/)).toBeInTheDocument();
    expect(screen.getByText(/集合は8時/)).toBeInTheDocument();
  });

  it("score >= 0.7 では何も描画しない", () => {
    const { container } = render(<ConfidenceBadge score={0.9} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("score 未取得 (undefined) では何も描画しない", () => {
    const { container } = render(<ConfidenceBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
