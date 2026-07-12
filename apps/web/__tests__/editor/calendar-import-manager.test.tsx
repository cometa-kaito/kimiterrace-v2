import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 年間行事予定表ページの取込フロー開閉マネージャ（{@link CalendarImportManager}）の固定テスト
 * （教員 FB「取込は＋ボタンから開く・主役は登録済み一覧」・#1274 follow-up）。
 *
 * - 取込セクション（ファイル選択 → AI 読み取り → プレビュー → 保存）は**初期非表示**で、
 *   タイトル行の「＋ ファイルから取り込む」で展開する（再クリック / セクション内「閉じる」で畳む）。
 * - 読み取り中またはプレビュー（draft）がある間は、畳む操作に**破棄確認**（「読み取り結果を
 *   破棄しますか？」）を挟む。確認なしで状態を消さない。
 * - 置き換え保存の成功時は自動で畳み、保存結果メッセージを一覧の上へ引き継ぐ（router.refresh 済み）。
 * - 既存フロー（認可・保存・プレビュー編集・月グループ化・#1276 フォーカス凍結）自体は
 *   本 PR で変えない（プレビュー展開までを煙テストで踏むのみ）。
 */

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  draftAction: vi.fn(),
  saveAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));
vi.mock("@/lib/editor/calendar-import-actions", () => ({
  draftCalendarImportAction: h.draftAction,
  saveCalendarImportAction: h.saveAction,
}));

import { CalendarImportManager } from "../../app/app/editor/calendar-import/_components/CalendarImportManager";

const OPEN_LABEL = "＋ ファイルから取り込む";
const TOGGLE_CLOSE_LABEL = "取込を閉じる";
const DISCARD_TITLE = "読み取り結果を破棄しますか？";

const DRAFT_OK = {
  ok: true as const,
  events: [{ summary: "体育祭", startDate: "2026-06-10", allDay: true }],
  dropped: {
    invalidDate: 0,
    outOfWindow: 0,
    duplicates: 0,
    overCap: 0,
    endDateStripped: 0,
    malformed: 0,
  },
  window: { fiscalYear: 2026, start: "2026-04-01", end: "2027-03-31" },
  suspectedNameCount: 0,
  fileName: "annual.xlsx",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderManager() {
  return render(
    <CalendarImportManager existingCount={0} existingFileName={null}>
      <p>registered-list</p>
    </CalendarImportManager>,
  );
}

/** ＋ボタンで展開 → ファイル選択 → AI 読み取り（mock）→ プレビュー表示まで進める。 */
async function openWithDraft() {
  h.draftAction.mockResolvedValue(DRAFT_OK);
  fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));
  fireEvent.change(screen.getByLabelText("年間行事予定表ファイル"), {
    target: { files: [new File(["x"], "annual.xlsx")] },
  });
  // 非同期 transition を完走させる（pending 中は保存ボタンが disabled のまま）。既存 tsx テストと同作法。
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "AI で読み取る" }));
  });
  expect(screen.getByText("2. 内容を確認して保存する")).toBeTruthy();
  expect(screen.getByRole("button", { name: "AI で読み取る" })).toBeTruthy();
}

describe("CalendarImportManager", () => {
  it("初期状態は取込セクション非表示・一覧（children）と＋ボタンのみ", () => {
    renderManager();
    expect(screen.getByText("registered-list")).toBeTruthy();
    const toggle = screen.getByRole("button", { name: OPEN_LABEL });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("年間行事予定表ファイル")).toBeNull();
    expect(screen.queryByText("ファイルから取り込む")).toBeNull();
  });

  it("＋ボタンで展開し、draft が無ければ「閉じる」で確認なしに畳む", () => {
    renderManager();
    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));
    expect(
      screen.getByRole("button", { name: TOGGLE_CLOSE_LABEL }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByLabelText("年間行事予定表ファイル")).toBeTruthy();
    expect(screen.getByText("ファイルから取り込む")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    // 破棄されるものが無い = 確認ダイアログを出さずにそのまま畳む。
    expect(screen.queryByText(DISCARD_TITLE)).toBeNull();
    expect(screen.queryByLabelText("年間行事予定表ファイル")).toBeNull();
  });

  it("AI 読み取り中は畳む操作に破棄確認を挟む（pending も dirty）", async () => {
    renderManager();
    // 手動 resolve の Promise で「読み取り中」を固定する（テスト末尾で必ず解決する:
    // React 19 の非同期 transition はグローバルに直列化されるため、未解決のまま残すと
    // 後続テストの transition が永遠に pending で毒される）。
    let resolveDraft!: (r: typeof DRAFT_OK) => void;
    h.draftAction.mockReturnValue(
      new Promise((resolve) => {
        resolveDraft = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));
    fireEvent.change(screen.getByLabelText("年間行事予定表ファイル"), {
      target: { files: [new File(["x"], "annual.xlsx")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI で読み取る" }));
    await screen.findByRole("button", { name: "読み取り中…" });

    fireEvent.click(screen.getByRole("button", { name: TOGGLE_CLOSE_LABEL }));
    expect(screen.getByText(DISCARD_TITLE)).toBeTruthy();

    // 後始末（上記コメント参照）。
    await act(async () => {
      resolveDraft(DRAFT_OK);
    });
  });

  it("プレビュー表示中の畳む操作は破棄確認 → キャンセルで維持・確定で破棄して畳む", async () => {
    renderManager();
    await openWithDraft();

    // 畳もうとすると確認ダイアログ（確認なしで状態を消さない）。
    fireEvent.click(screen.getByRole("button", { name: TOGGLE_CLOSE_LABEL }));
    expect(screen.getByText(DISCARD_TITLE)).toBeTruthy();

    // キャンセル → プレビューは残る。
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByText(DISCARD_TITLE)).toBeNull();
    expect(screen.getByText("2. 内容を確認して保存する")).toBeTruthy();

    // 確定 → 畳まれ、再展開してもプレビューは復活しない（破棄済み）。
    fireEvent.click(screen.getByRole("button", { name: TOGGLE_CLOSE_LABEL }));
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }));
    expect(screen.queryByText("2. 内容を確認して保存する")).toBeNull();
    expect(screen.queryByLabelText("年間行事予定表ファイル")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: OPEN_LABEL }));
    expect(screen.queryByText("2. 内容を確認して保存する")).toBeNull();
  });

  it("保存成功で自動的に畳み、保存結果メッセージを一覧の上に出す", async () => {
    renderManager();
    await openWithDraft();
    h.saveAction.mockResolvedValue({ ok: true, deleted: 0, inserted: 1 });

    fireEvent.click(screen.getByRole("button", { name: "保存（前回のファイル取込を置き換え）" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "置き換えて保存" }));
    });

    // 自動で畳まれて一覧が主役に戻り、保存メッセージ（role=status）が残る。
    await screen.findByText("保存しました（前回の取込 0 件を削除し、1 件を登録）。");
    expect(screen.queryByLabelText("年間行事予定表ファイル")).toBeNull();
    expect(screen.queryByText(DISCARD_TITLE)).toBeNull();
    const toggle = screen.getByRole("button", { name: OPEN_LABEL });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(h.refresh).toHaveBeenCalled();

    // 再展開すると保存メッセージは消え、まっさらな取込フローから始まる。
    fireEvent.click(toggle);
    expect(screen.queryByText("保存しました（前回の取込 0 件を削除し、1 件を登録）。")).toBeNull();
    expect(screen.getByLabelText("年間行事予定表ファイル")).toBeTruthy();
    expect(screen.queryByText("2. 内容を確認して保存する")).toBeNull();
  });
});
