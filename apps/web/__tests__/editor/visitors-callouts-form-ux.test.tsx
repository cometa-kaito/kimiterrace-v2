import type { ClassVisitor } from "@kimiterrace/db";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 来校者一覧 / 生徒呼び出しフォームの UX 改善を固定する（finding④ 必須/任意の明示・finding⑥ 空状態の罫線
 * プレースホルダ・finding② 教員向け注記から内部識別子 ADR-034 を除去）。
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/editor/visitors-actions", () => ({
  setVisitorsAction: vi.fn(async () => ({ ok: true, data: { count: 0 } })),
}));
vi.mock("@/lib/editor/callouts-actions", () => ({
  setCalloutsAction: vi.fn(async () => ({ ok: true, data: { count: 0 } })),
}));

import { CalloutsEditor } from "../../app/app/editor/[classId]/_components/CalloutsEditor";
import { VisitorsEditor } from "../../app/app/editor/[classId]/_components/VisitorsEditor";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-21";

afterEach(cleanup);

describe("来校者一覧フォーム UX", () => {
  it("必須（氏名）と任意のマークを出し、凡例を示す", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    // 必須は 1 つ（氏名）、任意は複数（時刻/所属/用件/対応者/備考）。
    expect(screen.getAllByText("必須").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("任意").length).toBeGreaterThanOrEqual(2);
  });

  it("0 件のとき罫線プレースホルダで投入位置を示す", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    expect(screen.getByText("「来校者を追加」で行を追加します")).toBeTruthy();
  });

  it("行があるときはプレースホルダを出さない", () => {
    const item = {
      id: "v1",
      visitorName: "来校 太郎",
      affiliation: null,
      scheduledTime: null,
      purpose: null,
      host: null,
      note: null,
    } as ClassVisitor;
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[item]} />);
    expect(screen.queryByText("「来校者を追加」で行を追加します")).toBeNull();
  });
});

describe("生徒呼び出しフォーム UX", () => {
  it("必須（生徒氏名）と任意のマーク・凡例を出す", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    expect(screen.getAllByText("必須").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("任意").length).toBeGreaterThanOrEqual(2);
  });

  it("教員向け注記に内部識別子 ADR-034 を出さない（理由説明は残す）", () => {
    const { container } = render(
      <CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />,
    );
    expect(container.textContent).not.toContain("ADR-034");
    // 理由（取り違え防止のため実名表示）は残す。
    expect(container.textContent).toContain("取り違え防止");
  });

  it("0 件のとき罫線プレースホルダで投入位置を示す", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    expect(screen.getByText("「呼び出しを追加」で行を追加します")).toBeTruthy();
  });
});
