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
import type { FileImportedEventSummary } from "../../lib/editor/calendar-import-diff";

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

function renderManager(existingFileEvents: FileImportedEventSummary[] = []) {
  return render(
    <CalendarImportManager
      existingFileEvents={existingFileEvents}
      existingFileName={existingFileEvents.length > 0 ? "previous.xlsx" : null}
    >
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
    h.saveAction.mockResolvedValue({
      ok: true,
      mode: "replace",
      deleted: 0,
      inserted: 1,
      keptExisting: 0,
    });

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

/** 既存のファイル取込由来イベント（差分テスト用の plain 形）を組む。 */
function exEvent(
  summary: string,
  startDate: string,
  endDate: string | null = null,
): FileImportedEventSummary {
  return { summary, startDate, endDate, location: null };
}

/** プレビューまで進めて保存確認ダイアログを開く（draft は {@link DRAFT_OK} = 体育祭 6/10 の 1 件）。 */
async function openConfirmDialog() {
  await openWithDraft();
  fireEvent.click(screen.getByRole("button", { name: "保存（前回のファイル取込を置き換え）" }));
  expect(screen.getByText("ファイル取込を置き換えて保存しますか？")).toBeTruthy();
}

/** counts 行（span 直下に追加/継続/削除を 1 行で出す）の完全一致マッチャ。 */
function countsLine(text: string) {
  return screen.getByText(
    (_, el) => el?.tagName === "SPAN" && el.textContent?.replace(/\s+/g, " ").trim() === text,
  );
}

describe("置き換え保存の確認ダイアログの差分表示（#1259 教員 FB）", () => {
  it("既存取込があるとき、追加/継続/削除の件数と削除される行事の一覧（日付 + 行事名）を出す", async () => {
    renderManager([
      exEvent("体育祭", "2026-06-10"),
      exEvent("入学式", "2026-04-08"),
      exEvent("文化祭", "2026-10-03", "2026-10-04"),
    ]);
    await openConfirmDialog();

    // draft（体育祭 6/10）はキー一致 = 継続。残る 2 件が「削除される行事」として漏れなく出る。
    expect(countsLine("追加 0 件 / 継続 1 件 / 削除される行事 2 件")).toBeTruthy();
    expect(screen.getByText("4/8(水) 入学式")).toBeTruthy();
    // 複数日行事は期間表記（eventDateRangeLabel 再利用）。
    expect(screen.getByText("10/3(土)〜10/4(日) 文化祭")).toBeTruthy();
    expect(screen.queryByText("削除される行事はありません。")).toBeNull();
  });

  it("削除 0 件（同じ内容の再取込）は「削除される行事はありません」を明示する", async () => {
    renderManager([exEvent("体育祭", "2026-06-10")]);
    await openConfirmDialog();

    expect(countsLine("追加 0 件 / 継続 1 件 / 削除される行事 0 件")).toBeTruthy();
    expect(screen.getByText("削除される行事はありません。")).toBeTruthy();
  });

  it("削除される行事が多い場合は先頭 20 件 + 「他 N 件」（沈黙の切り捨て禁止）", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      exEvent(`行事${i + 1}`, `2026-05-${String(i + 1).padStart(2, "0")}`),
    );
    renderManager(many);
    await openConfirmDialog();

    // 総件数は必ず出す（一覧の切り詰めと独立）。
    expect(screen.getByText("削除される行事 25 件")).toBeTruthy();
    expect(screen.getByText("他 5 件")).toBeTruthy();
    // 21 件目以降は一覧に出ない（件数で補足済み）。
    expect(screen.queryByText((_, el) => el?.textContent === "5/21(木) 行事21")).toBeNull();
  });

  it("初回取込（既存 0 件）は従来どおりのシンプルな確認のまま", async () => {
    renderManager();
    await openConfirmDialog();

    expect(screen.getByText("1 件の行事を保存します。")).toBeTruthy();
    expect(screen.queryByText(/削除される行事/)).toBeNull();
  });
});

describe("保存モード選択（完全置き換え / 既存に追加・更新・2026-07-12 ユーザー判断）", () => {
  it("既定は「完全に置き換える」で、従来の置換ボタン/確認のまま", async () => {
    renderManager([exEvent("体育祭", "2026-06-10")]);
    await openWithDraft();

    const replaceRadio = screen.getByRole("radio", { name: /完全に置き換える/ });
    expect((replaceRadio as HTMLInputElement).checked).toBe(true);
    expect(
      screen.getByRole("button", { name: "保存（前回のファイル取込を置き換え）" }),
    ).toBeTruthy();
  });

  it("マージ選択で保存ボタン・確認ダイアログがマージ表示になり mode=merge で保存する", async () => {
    renderManager([exEvent("体育祭", "2026-06-10"), exEvent("入学式", "2026-04-08")]);
    await openWithDraft();

    fireEvent.click(screen.getByRole("radio", { name: /既存に追加・更新する/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存（既存に追加・更新）" }));
    expect(screen.getByText("既存に追加・更新して保存しますか？")).toBeTruthy();
    // draft（体育祭 6/10）はキー一致 = 更新。入学式は削除されず「そのまま残る既存」（マージの本丸）。
    expect(countsLine("追加 0 件 / 更新 1 件 / そのまま残る既存 1 件")).toBeTruthy();
    expect(screen.getByText("削除される行事はありません。")).toBeTruthy();
    expect(screen.queryByText(/削除される行事 \d+ 件/)).toBeNull();

    h.saveAction.mockResolvedValue({
      ok: true,
      mode: "merge",
      deleted: 1,
      inserted: 1,
      keptExisting: 1,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "追加・更新して保存" }));
    });
    expect(h.saveAction).toHaveBeenCalledWith(expect.anything(), expect.anything(), "merge");
    await screen.findByText("保存しました（追加 0 件・更新 1 件・既存 1 件はそのまま）。");
  });
});
