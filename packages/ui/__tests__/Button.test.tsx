import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../src/Button";

describe("Button", () => {
  it("子要素を描画し、既定 type は button（暗黙 submit 回避）", () => {
    render(<Button>保存</Button>);
    const btn = screen.getByRole("button", { name: "保存" });
    expect(btn).toHaveAttribute("type", "button");
  });

  it("呼出側が type=submit を上書きできる", () => {
    render(<Button type="submit">送信</Button>);
    expect(screen.getByRole("button", { name: "送信" })).toHaveAttribute("type", "submit");
  });

  it("primary variant の背景色を適用する", () => {
    render(<Button variant="primary">x</Button>);
    expect(screen.getByRole("button").style.background).toBe("rgb(234, 88, 12)"); // #ea580c
  });

  it("hover で背景が hover 色に変わり、leave で戻る", () => {
    render(<Button variant="primary">x</Button>);
    const btn = screen.getByRole("button");
    fireEvent.mouseEnter(btn);
    expect(btn.style.background).toBe("rgb(194, 65, 12)"); // primaryHover #c2410c
    fireEvent.mouseLeave(btn);
    expect(btn.style.background).toBe("rgb(234, 88, 12)"); // 戻る
  });

  it("disabled は不活性表示（opacity/cursor）かつ hover 色を出さない", () => {
    render(
      <Button variant="primary" disabled>
        x
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    expect(btn.style.opacity).toBe("0.55");
    expect(btn.style.cursor).toBe("default");
    fireEvent.mouseEnter(btn);
    // disabled 中は hover 色に変えない（base 色のまま）。
    expect(btn.style.background).toBe("rgb(234, 88, 12)");
  });

  it("onClick を透過し、呼出側 onMouseEnter も内部 hover と両立して呼ぶ", () => {
    const onClick = vi.fn();
    const onMouseEnter = vi.fn();
    render(
      <Button onClick={onClick} onMouseEnter={onMouseEnter} aria-label="実行">
        x
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "実行" });
    fireEvent.mouseEnter(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onMouseEnter).toHaveBeenCalledTimes(1); // 内部 setHover と共存（潰さない）
    expect(btn.style.background).toBe("rgb(194, 65, 12)"); // hover も効く
  });
});
