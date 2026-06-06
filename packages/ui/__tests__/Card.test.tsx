import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "../src/Card";
import { space } from "../src/tokens";

describe("Card", () => {
  it("子要素を描画する", () => {
    render(
      <Card>
        <p>本文</p>
      </Card>,
    );
    expect(screen.getByText("本文")).toBeInTheDocument();
  });

  it("既定では内側余白を付ける", () => {
    const { container } = render(<Card>x</Card>);
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.padding).toBe(space.lg);
  });

  it("padded=false で余白を外す（テーブル等を端まで敷く用途）", () => {
    const { container } = render(<Card padded={false}>x</Card>);
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.padding).toBe("0px");
  });

  it("style を上書きマージできる", () => {
    const { container } = render(<Card style={{ marginTop: "2rem" }}>x</Card>);
    const card = container.firstElementChild as HTMLElement;
    expect(card.style.marginTop).toBe("2rem");
  });
});
