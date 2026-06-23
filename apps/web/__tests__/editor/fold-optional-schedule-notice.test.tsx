import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 予定 / 連絡エディタの行ごと「詳細（任意項目）」畳み込み（引き算レーン・{@link RowDetails}）を固定する。
 *
 * 方針: 主役だけ常時表示し、任意項目は行ごとの「詳細 ▾」で開閉する。
 * - 予定: 主役 = 時限 / 科目、詳細 = 補足 / 場所 / 対象者。
 * - 連絡: 主役 = 連絡事項、詳細 = 重要 / 表示日数。
 * 絶対則: 既に値（既定でない設定）がある行は初期から開く（入力済みを隠さない）。折りたたんでも値は state に残る。
 *
 * 保存・検証・RLS/監査は Server Action 側が担うため、action / router をモックして UI のみ見る。
 */

const h = vi.hoisted(() => ({
  push: vi.fn(),
  setScheduleAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  setNoticesAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setScheduleAction(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: vi.fn(),
}));

import { NoticeEditor } from "../../app/app/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "../../app/app/editor/[classId]/_components/ScheduleEditor";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-23";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("予定 — 任意項目（補足/場所/対象者）を行ごとに畳む", () => {
  it("主役（時限/科目）は常時、任意項目は既定で隠れ、「詳細」で現れる", () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ period: 1, subject: "数学" }]}
        showDateNav={false}
      />,
    );
    expect(screen.getByLabelText("1 行目の時限")).toBeTruthy();
    expect(screen.getByLabelText("1 行目の科目名")).toBeTruthy();
    expect(screen.queryByLabelText("1 行目の補足")).toBeNull();
    expect(screen.queryByLabelText("1 行目の場所")).toBeNull();
    expect(screen.queryByLabelText("1 行目の対象者")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 行目の詳細項目" }));
    expect(screen.getByLabelText("1 行目の補足")).toBeTruthy();
    expect(screen.getByLabelText("1 行目の場所")).toBeTruthy();
    expect(screen.getByLabelText("1 行目の対象者")).toBeTruthy();
  });

  it("任意項目に値がある行は初期から開き、折りたたんでも値は失われず開き直すと復元される", () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ period: 1, subject: "数学", location: "体育館" }]}
        showDateNav={false}
      />,
    );
    // 初期から開いて値が見える。
    expect((screen.getByLabelText("1 行目の場所") as HTMLInputElement).value).toBe("体育館");
    // 折りたたむと「入力あり」を示す（色だけに頼らない）。
    fireEvent.click(screen.getByRole("button", { name: "1 行目の詳細項目" }));
    expect(screen.queryByLabelText("1 行目の場所")).toBeNull();
    expect(screen.getByText("（入力あり）")).toBeTruthy();
    // 開き直すと値が残っている。
    fireEvent.click(screen.getByRole("button", { name: "1 行目の詳細項目" }));
    expect((screen.getByLabelText("1 行目の場所") as HTMLInputElement).value).toBe("体育館");
  });
});

describe("連絡 — 任意設定（重要/表示日数）を行ごとに畳む", () => {
  it("本文は常時、重要/表示日数は既定で隠れ、「詳細」で現れる", () => {
    render(
      <NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[{ text: "明日は遠足です" }]} />,
    );
    expect(screen.getByLabelText("1 件目の連絡事項")).toBeTruthy();
    expect(screen.queryByLabelText("1 件目の表示日数")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 件目の詳細項目" }));
    expect(screen.getByLabelText("1 件目の表示日数")).toBeTruthy();
  });

  it("既定でない設定（重要 / 表示日数>1）の行は初期から開く", () => {
    render(
      <NoticeEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[
          { text: "重要連絡", isHighlight: true },
          { text: "数日出す", displayDays: 3 },
        ]}
      />,
    );
    expect(screen.getByLabelText("1 件目の表示日数")).toBeTruthy();
    expect(screen.getByLabelText("2 件目の表示日数")).toBeTruthy();
  });
});
