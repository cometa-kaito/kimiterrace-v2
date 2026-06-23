import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

/**
 * 来校者一覧 / 生徒呼び出しエディタの行ごと「詳細（任意項目）」畳み込み（引き算・{@link RowDetails}）を固定する。
 * 主役（時刻・氏名）だけ常時表示し、任意項目（来校者=所属/用件/対応者/備考・呼び出し=呼び出し先/用件）は
 * 行ごとの「詳細 ▾」で開閉する。既に値がある行は初期から開く（入力済みを隠さない）。
 * 折りたたみ→「入力あり」→開き直しで復元、の固定は予定側（fold-optional-schedule-notice）で代表して行う。
 * action / router はモックし UI のみ見る。
 */

const h = vi.hoisted(() => ({
  setVisitorsAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { count: 0 } })),
  setCalloutsAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { count: 0 } })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/editor/visitors-actions", () => ({
  setVisitorsAction: (...a: unknown[]) => h.setVisitorsAction(...a),
}));
vi.mock("@/lib/editor/callouts-actions", () => ({
  setCalloutsAction: (...a: unknown[]) => h.setCalloutsAction(...a),
}));

import { CalloutsEditor } from "../../app/app/editor/[classId]/_components/CalloutsEditor";
import { VisitorsEditor } from "../../app/app/editor/[classId]/_components/VisitorsEditor";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-23";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("来校者: 主役（時刻/氏名）は常時、任意項目は既定で隠れ「詳細」で現れる。値ありの行は初期から開く", () => {
  const base = {
    scheduledTime: null,
    visitorName: "山田太郎",
    affiliation: null,
    purpose: null,
    host: null,
    note: null,
  };
  render(<VisitorsEditor classId={CLASS_ID} date={DATE} initialItems={[base as never]} />);
  expect(screen.getByLabelText("1 行目の時刻")).toBeTruthy();
  expect(screen.getByLabelText("1 行目の氏名")).toBeTruthy();
  expect(screen.queryByLabelText("1 行目の所属")).toBeNull();
  expect(screen.queryByLabelText("1 行目の備考")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "1 行目の詳細項目" }));
  expect(screen.getByLabelText("1 行目の所属")).toBeTruthy();
  expect(screen.getByLabelText("1 行目の用件")).toBeTruthy();
  expect(screen.getByLabelText("1 行目の対応者")).toBeTruthy();
  expect(screen.getByLabelText("1 行目の備考")).toBeTruthy();

  cleanup();
  render(
    <VisitorsEditor
      classId={CLASS_ID}
      date={DATE}
      initialItems={[{ ...base, affiliation: "〇〇高校" } as never]}
    />,
  );
  expect((screen.getByLabelText("1 行目の所属") as HTMLInputElement).value).toBe("〇〇高校");
});

it("呼び出し: 主役（時刻/生徒氏名）は常時、任意項目は既定で隠れ「詳細」で現れる。値ありの行は初期から開く", () => {
  const base = { scheduledTime: null, studentName: "佐藤花子", location: null, reason: null };
  render(<CalloutsEditor classId={CLASS_ID} date={DATE} initialItems={[base as never]} />);
  expect(screen.getByLabelText("1 行目の時刻")).toBeTruthy();
  expect(screen.getByLabelText("1 行目の生徒氏名")).toBeTruthy();
  expect(screen.queryByLabelText("1 行目の呼び出し先")).toBeNull();
  expect(screen.queryByLabelText("1 行目の用件")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "1 行目の詳細項目" }));
  expect(screen.getByLabelText("1 行目の呼び出し先")).toBeTruthy();
  expect(screen.getByLabelText("1 行目の用件")).toBeTruthy();

  cleanup();
  render(
    <CalloutsEditor
      classId={CLASS_ID}
      date={DATE}
      initialItems={[{ ...base, location: "職員室" } as never]}
    />,
  );
  expect((screen.getByLabelText("1 行目の呼び出し先") as HTMLInputElement).value).toBe("職員室");
});
