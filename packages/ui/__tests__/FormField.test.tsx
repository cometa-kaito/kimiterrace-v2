import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FormField } from "../src/FormField";

describe("FormField", () => {
  it("ラベルと子コントロールを id で結ぶ（getByLabelText で引ける）", () => {
    render(
      <FormField label="学校名">
        <input name="name" />
      </FormField>,
    );
    const input = screen.getByLabelText("学校名");
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("id")).toBeTruthy(); // 採番 id が注入される
  });

  it("required で装飾の必須印（aria-hidden）を出す", () => {
    render(
      <FormField label="学校名" required>
        <input />
      </FormField>,
    );
    const star = screen.getByText("*");
    expect(star).toHaveAttribute("aria-hidden", "true");
  });

  it("hint を描画し、コントロールの aria-describedby に hint の id を結ぶ。error 無しなら aria-invalid を立てない", () => {
    render(
      <FormField label="学校名" hint="正式名称を入力">
        <input />
      </FormField>,
    );
    const input = screen.getByLabelText("学校名");
    const hint = screen.getByText("正式名称を入力");
    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("error を role=alert で出し、コントロールに aria-invalid と aria-describedby(error id) を立てる", () => {
    render(
      <FormField label="学校名" error="学校名は必須です">
        <input />
      </FormField>,
    );
    const input = screen.getByLabelText("学校名");
    const err = screen.getByRole("alert");
    expect(err).toHaveTextContent("学校名は必須です");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", err.id);
  });

  it("hint と error 両方あれば aria-describedby に hint→error の順で結ぶ", () => {
    render(
      <FormField label="メール" hint="連絡先" error="形式が不正です">
        <input />
      </FormField>,
    );
    const input = screen.getByLabelText("メール");
    const hint = screen.getByText("連絡先");
    const err = screen.getByRole("alert");
    expect(input).toHaveAttribute("aria-describedby", `${hint.id} ${err.id}`);
  });

  it("htmlFor で id を上書きできる", () => {
    render(
      <FormField label="学校名" htmlFor="school-name">
        <input />
      </FormField>,
    );
    expect(screen.getByLabelText("学校名")).toHaveAttribute("id", "school-name");
  });
});
