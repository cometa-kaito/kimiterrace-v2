import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WYSIWYG（実レイアウト上のライブプレビュー連動）編集器の主要動作を固定する（PR・B）。
 *
 * 検証点:
 * - 既存の見出し「予定」「連絡」「提出物」を**温存**する（golden-path e2e 依存・盤面タブの回帰ガード）。
 * - 既存エディタの placeholder「連絡事項」を温存する（golden-path が NoticeEditor を駆動するセレクタ）。
 * - 実機と同一の盤面ライブプレビューを描画する（`SignageBoardView` 由来の領域「広告」が出る）。
 * - 盤面の領域ボタン（予定/連絡/提出物を編集）をクリックすると、対応エディタへフォーカスが移る（連動）。
 * - base=null（盤面取得不能）でも従来のフォーム編集が出る（フォールバック・盤面を壊さない）。
 *
 * 保存・自動保存・検証は各エディタが温存して担うため、ここでは server action をモックして UI 連動のみ見る。
 */

const h = vi.hoisted(() => ({
  setScheduleAction: vi.fn(),
  setNoticesAction: vi.fn(),
  setAssignmentsAction: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setScheduleAction(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: (...a: unknown[]) => h.setAssignmentsAction(...a),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh, push: h.push }),
}));

import { WysiwygBoardEditor } from "../../app/app/editor/[classId]/_components/WysiwygBoardEditor";
import type { EditorBoardBase } from "../../lib/editor/editor-board-preview";

const TODAY = "2026-06-15";
const CLASS_ID = "11111111-1111-1111-1111-111111111111";

function base(): EditorBoardBase {
  return {
    date: TODAY,
    designPattern: "pattern1",
    daily: {
      date: TODAY,
      schedules: { items: [], source: null },
      notices: { items: [], source: null },
      assignments: { items: [], source: null },
      quietHours: { items: [], source: null },
    },
    scheduleDays: [{ date: TODAY, schedule: { items: [], source: null } }],
    ads: [],
    weather: null,
    classContext: { className: "1年A組", gradeName: "1年", departmentName: "電子工学科" },
    presenceCount: null,
    visitors: null,
    callouts: null,
    trainStatus: null,
    blackout: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WysiwygBoardEditor", () => {
  it("見出し（予定/連絡/提出物）は編集器側に一意に出す（盤面プレビューは aria-hidden で二重化しない＝e2e 温存）", () => {
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={base()}
        initialSchedules={[]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    // 盤面プレビューも内部に「連絡」「提出物」見出しを持つが aria-hidden なので role=heading は編集器の 1 つだけ。
    // getByRole は複数一致で投げるため、これが通る = 二重化していない（golden-path の strict locator 温存）。
    expect(screen.getByRole("heading", { name: "予定", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "連絡", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "提出物", level: 2 })).toBeTruthy();
    // golden-path が NoticeEditor を掴む placeholder（行があるときに出る）。
    expect(screen.getByPlaceholderText("連絡事項")).toBeTruthy();
  });

  it("実機と同一の盤面ライブプレビュー（SignageBoardView 再利用）を描画する", () => {
    const { container } = render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={base()}
        initialSchedules={[]}
        initialNotices={[]}
        initialAssignments={[]}
      />,
    );
    // SignageBoardView 由来の広告ゾーン（aria-hidden の装飾プレビュー内）。DOM 上に存在 = 盤面を重複実装せず
    // 実機部品を再利用している証跡（aria-label="広告" の section が描かれる）。
    expect(container.querySelector('[aria-label="広告"]')).not.toBeNull();
    // 領域編集ボタンが盤面に重なって出る（こちらは操作可能なので AT 公開）。
    expect(screen.getByRole("button", { name: "予定を編集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "連絡を編集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提出物を編集" })).toBeTruthy();
  });

  it("盤面の領域ボタンを押すと対応エディタの入力にフォーカスが移る（連動）", () => {
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={base()}
        initialSchedules={[]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    // scrollIntoView は jsdom 未実装なので noop スタブを当てる（フォーカス挙動のみ検証）。
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "連絡を編集" }));
    // 連絡の入力（placeholder 連絡事項）にフォーカスが当たる。
    expect(document.activeElement).toBe(screen.getByPlaceholderText("連絡事項"));
    // 押した領域ボタンは選択状態（aria-pressed）。
    expect(screen.getByRole("button", { name: "連絡を編集" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("連絡を編集するとライブプレビュー盤面に反映される（プレビュー連動）", () => {
    const { container } = render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={base()}
        initialSchedules={[]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    const input = screen.getByPlaceholderText("連絡事項") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "プレビュー連動テスト連絡" } });
    // 盤面（aria-hidden の装飾プレビュー）は編集に即時連動する。AT 非公開なので DOM テキストで照合する。
    expect(container.textContent).toContain("プレビュー連動テスト連絡");
  });

  it("base=null（盤面取得不能）でも従来のフォーム編集が出る（フォールバック）", () => {
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={null}
        initialSchedules={[]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    // 盤面プレビュー（領域ボタン）は出ないが、編集器（見出し + placeholder）は出る。
    expect(screen.queryByRole("button", { name: "連絡を編集" })).toBeNull();
    expect(screen.getByRole("heading", { name: "連絡", level: 2 })).toBeTruthy();
    expect(screen.getByPlaceholderText("連絡事項")).toBeTruthy();
  });
});
