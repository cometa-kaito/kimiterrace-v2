import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 来校者一覧 / 生徒呼び出しエディタの **フォームの分かりやすさ**（引き算レーン・群A）を固定する。
 *
 * 検証点（LEDGER 由来）:
 * - v2-ed-uo9: 必須/任意が分かりにくい → 凡例「* = 必須」を出し、必須列（氏名 / 生徒氏名）に必須印を添える。
 * - v2-ed-uo6: 空状態の枠が不要 → 行が無いとき点線プレースホルダで投入位置を示唆する。
 * - v2-ed-ai4: 教員向け注記から内部識別子「ADR-034」を除去（理由文は残す）。
 *
 * 保存・検証・RLS/監査は Server Action 側が担うため、ここでは action / router をモックして UI のみ見る。
 */

const h = vi.hoisted(() => ({
  setVisitorsAction: vi.fn(),
  setCalloutsAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/editor/visitors-actions", () => ({
  setVisitorsAction: (...a: unknown[]) => h.setVisitorsAction(...a),
}));
vi.mock("@/lib/editor/callouts-actions", () => ({
  setCalloutsAction: (...a: unknown[]) => h.setCalloutsAction(...a),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));

import { CalloutsEditor } from "../../app/app/editor/[classId]/_components/CalloutsEditor";
import { VisitorsEditor } from "../../app/app/editor/[classId]/_components/VisitorsEditor";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-22";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("来校者一覧 / 生徒呼び出し — フォームの分かりやすさ", () => {
  it("来校者一覧: 凡例と必須印を出し、空状態は点線プレースホルダで示す", () => {
    render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    // 凡例（必須/任意の説明）。
    expect(screen.getByText(/= 必須/)).toBeTruthy();
    // 必須列ヘッダー「氏名」に SR 向けの「（必須）」が添う。
    const nameHeader = screen.getByRole("columnheader", { name: /氏名/ });
    expect(within(nameHeader).getByText("（必須）")).toBeTruthy();
    // 空状態のプレースホルダ（投入位置の示唆）。
    expect(screen.getByText(/まだ来校者がありません/)).toBeTruthy();
  });

  it("来校者一覧: 行があるときは空状態プレースホルダを出さない", () => {
    render(
      <VisitorsEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[
          {
            scheduledTime: "10:00",
            visitorName: "山田太郎",
            affiliation: null,
            purpose: null,
            host: null,
            note: null,
          } as never,
        ]}
      />,
    );
    expect(screen.queryByText(/まだ来校者がありません/)).toBeNull();
  });

  it("生徒呼び出し: 凡例・必須印・空状態を出し、注記に ADR 番号を出さない（理由文は残す）", () => {
    render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[]} />);
    expect(screen.getByText(/= 必須/)).toBeTruthy();
    const nameHeader = screen.getByRole("columnheader", { name: /生徒氏名/ });
    expect(within(nameHeader).getByText("（必須）")).toBeTruthy();
    expect(screen.getByText(/まだ呼び出しがありません/)).toBeTruthy();
    // 取り違え防止の理由文は残す。
    expect(screen.getByText(/取り違え防止/)).toBeTruthy();
    // 内部識別子「ADR-034」は教員向け注記に出さない。
    expect(screen.queryByText(/ADR-034/)).toBeNull();
  });
});
