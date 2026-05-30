import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContentStatusBadge } from "../../app/admin/contents/_components/ContentStatusBadge";

describe("ContentStatusBadge", () => {
  it("draft → 下書き", () => {
    render(<ContentStatusBadge status="draft" />);
    expect(screen.getByText("下書き")).toBeInTheDocument();
  });
  it("published → 公開中", () => {
    render(<ContentStatusBadge status="published" />);
    expect(screen.getByText("公開中")).toBeInTheDocument();
  });
  it("archived → 非公開", () => {
    render(<ContentStatusBadge status="archived" />);
    expect(screen.getByText("非公開")).toBeInTheDocument();
  });
  it("aria-label に状態名が入る", () => {
    render(<ContentStatusBadge status="published" />);
    expect(screen.getByLabelText("状態: 公開中")).toBeInTheDocument();
  });
});
