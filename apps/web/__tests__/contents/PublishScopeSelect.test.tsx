import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PublishScopeSelect } from "../../app/app/contents/_components/PublishScopeSelect";

describe("PublishScopeSelect (F04.4 公開先明示セレクタ)", () => {
  it("全スコープがラジオで描画される (全校も対等に存在)", () => {
    render(<PublishScopeSelect value={null} onChange={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(screen.getByLabelText(/クラス/)).toBeInTheDocument();
    expect(screen.getByText("全校")).toBeInTheDocument();
  });

  it("初期状態 (value=null) はどれも選択されていない (明示選択を強制)", () => {
    render(<PublishScopeSelect value={null} onChange={() => {}} />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
  });

  it("選択肢クリックで onChange が value を返す", () => {
    const onChange = vi.fn();
    render(<PublishScopeSelect value={null} onChange={onChange} />);
    fireEvent.click(screen.getByText("全校"));
    expect(onChange).toHaveBeenCalledWith("school");
  });

  it("value 指定でその選択肢が checked になる", () => {
    render(<PublishScopeSelect value="class" onChange={() => {}} />);
    const classRadio = screen.getByDisplayValue("class");
    expect(classRadio).toBeChecked();
    expect(screen.getByDisplayValue("school")).not.toBeChecked();
  });

  it("disabled で全ラジオが無効化される", () => {
    render(<PublishScopeSelect value={null} onChange={() => {}} disabled />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });
});
