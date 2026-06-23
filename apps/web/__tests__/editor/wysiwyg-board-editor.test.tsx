import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WYSIWYG（実レイアウト上のライブプレビュー連動）編集器の主要動作を固定する（PR・B / Approach A）。
 *
 * Approach A: 領域クリック層は別レイヤーの％オーバーレイではなく、盤面 `SignageBoardView` の**実セクション
 * そのもの**を覆う編集ボタン（`BoardRegionEditButton` を `editRegions` で挿入）。実描画要素を覆うので％近似の
 * ズレが原理的に起きない。
 *
 * 検証点:
 * - 既存の見出し「予定」「連絡」「提出物」を**温存**する（golden-path e2e 依存・盤面タブの回帰ガード）。
 *   盤面プレビューは編集モードで内部の region 名 / 装飾見出しを AT から外すので `role` 上は編集器の 1 つだけ
 *   （二重化しない＝strict locator 温存）。操作名は編集ボタンの `aria-label="○○を編集"` が担う。
 * - 既存エディタの placeholder「連絡事項」を温存する（golden-path が NoticeEditor を駆動するセレクタ）。
 * - 実機と同一の盤面ライブプレビューを描画する（`SignageBoardView` 由来の領域「広告」が出る）。
 * - 盤面の領域ボタン（予定/連絡/提出物を編集）をクリックすると、対応エディタへフォーカスが移る（連動）。
 * - base=null（盤面取得不能）でも従来のフォーム編集が出る（フォールバック・盤面を壊さない）。
 *
 * 保存・自動保存・検証は各エディタが温存して担うため、ここでは server action をモックして UI 連動のみ見る。
 */

// 保存アクションは実体（Server Action）と同じ成功結果（{ ok: true }）を返すモックにする。自動保存
// （useAutoSaveSection）の flush-on-unmount が cleanup 時に dirty な編集を保存しようとするため、undefined を
// 返すと `res.ok` 参照で unhandled rejection になる（実体は必ず結果オブジェクトを返す・#1136/#1138）。
const h = vi.hoisted(() => ({
  setScheduleAction: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  setNoticesAction: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  setAssignmentsAction: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
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
    news: null,
    weatherWarnings: null,
    heatAlerts: null,
    blackout: false,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // 一部テストで window.matchMedia を上書きするので毎回未定義へ戻す（他テストへの漏れ防止。jsdom 既定は未実装）。
  // focusRegion は typeof window.matchMedia === "function" でガードしているので undefined でも安全。
  (window as { matchMedia?: unknown }).matchMedia = undefined;
});

describe("WysiwygBoardEditor", () => {
  it("見出し（予定/連絡/提出物）は編集器側に一意に出す（盤面プレビューは編集モードで内部見出し/region 名を AT から外し二重化しない＝e2e 温存）", () => {
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
    // 盤面プレビューも内部に「連絡」「提出物」h2 を持つが編集モードで aria-hidden 化されるので role=heading は編集器の 1 つだけ。
    // getByRole は複数一致で投げるため、これが通る = 二重化していない（golden-path の strict locator 温存）。
    expect(screen.getByRole("heading", { name: "予定", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "連絡", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "提出物", level: 2 })).toBeTruthy();
    // 盤面内部の予定/連絡/提出物 section は編集モードで aria-label を外すので named region landmark にならない
    //（編集器側 region と衝突しない）。盤面に残る region landmark は広告（complementary）のみ。
    expect(screen.queryByRole("region", { name: "予定" })).toBeNull();
    expect(screen.queryByRole("region", { name: "連絡" })).toBeNull();
    expect(screen.queryByRole("region", { name: "提出物" })).toBeNull();
    // golden-path が NoticeEditor を掴む placeholder（行があるときに出る）。
    expect(screen.getAllByPlaceholderText("連絡事項")[0]).toBeTruthy();
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
    expect(document.activeElement).toBe(screen.getAllByPlaceholderText("連絡事項")[0]);
    // 押した領域ボタンは選択状態（aria-pressed）。
    expect(screen.getByRole("button", { name: "連絡を編集" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("領域クリックの遷移は smooth + block:nearest で最小移動・フォーカスは preventScroll（改善2: 急な飛びを減らす）", () => {
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
    // scrollIntoView は jsdom 未実装。スパイを当てて引数（behavior/block）を観測する。
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    // prefers-reduced-motion: reduce ではない既定（matchMedia.matches=false）→ smooth。
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia;
    // フォーカス対象（連絡入力）の focus 呼び出し引数（preventScroll）を観測。
    const noticeInput = screen.getAllByPlaceholderText("連絡事項")[0] as HTMLInputElement;
    const focusSpy = vi.spyOn(noticeInput, "focus");

    fireEvent.click(screen.getByRole("button", { name: "連絡を編集" }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("prefers-reduced-motion: reduce では smooth を無効化して瞬間移動する（改善2: NFR05）", () => {
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
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    // reduce 設定の利用者: matches=true → behavior:auto（瞬間移動）。
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia;

    fireEvent.click(screen.getByRole("button", { name: "連絡を編集" }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: "auto", block: "nearest" });
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
    const input = screen.getAllByPlaceholderText("連絡事項")[0] as HTMLInputElement;
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
    expect(screen.getAllByPlaceholderText("連絡事項")[0]).toBeTruthy();
  });

  it("showBoard=false では盤面プレビューを出さず編集セクションだけ出す（選択した日の編集＝フォームのみ）", () => {
    const { container } = render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={base()}
        showBoard={false}
        initialSchedules={[]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    // 盤面プレビュー（領域編集ボタン・広告ゾーン）は出ない。
    expect(screen.queryByRole("button", { name: "予定を編集" })).toBeNull();
    expect(container.querySelector('[aria-label="広告"]')).toBeNull();
    // 編集セクション（見出し + placeholder）は出る（パターン別の出し分けは維持）。
    expect(screen.getByRole("heading", { name: "予定", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "連絡", level: 2 })).toBeTruthy();
    expect(screen.getAllByPlaceholderText("連絡事項")[0]).toBeTruthy();
  });

  it("pattern2 ではパターンに含まれない編集欄（連絡 / 提出物）を出さず、予定の編集欄だけ出す（全パターン対応・完全な出し分け）", () => {
    // このクラスの実機が pattern2（掲示盤面）。編集対象ブロックは予定 / 来校者 / 生徒呼び出しで、連絡・提出物は
    // 盤面に出ない＝編集欄も出さない（来校者 / 生徒呼び出しの編集欄は親 page.tsx が盤面下に出す）。
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={{ ...base(), designPattern: "pattern2" }}
        initialSchedules={[]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    // 予定の編集欄（見出し + 盤面の領域編集ボタン）は出る（予定は全パターン共通ブロック）。
    expect(screen.getByRole("heading", { name: "予定", level: 2 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "予定を編集" })).toBeTruthy();
    // 連絡 / 提出物の編集欄（見出し + placeholder）は出さない（pattern2 の盤面に無いブロック）。
    expect(screen.queryByRole("heading", { name: "連絡", level: 2 })).toBeNull();
    expect(screen.queryByRole("heading", { name: "提出物", level: 2 })).toBeNull();
    expect(screen.queryByPlaceholderText("連絡事項")).toBeNull();
  });

  it("pattern4 では編集欄を連絡のみにする（予定/提出物は出さない・教員入力最小・2026-06-20）", () => {
    // pattern4 は天気/ニュース主役の自動寄り盤面で、教員入力は連絡（フリーワード）だけ。予定も持たない例外
    // なので、予定の編集欄も出さない（showSchedule=false）。盤面上のクリック編集も連絡のみ。
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={{ ...base(), designPattern: "pattern4" }}
        initialSchedules={[{ period: 1, subject: "数学" }]}
        initialNotices={[{ text: "既存連絡" }]}
        initialAssignments={[]}
      />,
    );
    // 連絡の編集欄（見出し + placeholder）と盤面のクリック編集ボタンは出る（pattern4 唯一の編集ブロック）。
    expect(screen.getByRole("heading", { name: "連絡", level: 2 })).toBeTruthy();
    expect(screen.getAllByPlaceholderText("連絡事項")[0]).toBeTruthy();
    expect(screen.getByRole("button", { name: "連絡を編集" })).toBeTruthy();
    // 予定 / 提出物の編集欄は出さない（pattern4 の盤面に無い＝死セクション防止）。盤面のクリック編集も予定は無い。
    expect(screen.queryByRole("heading", { name: "予定", level: 2 })).toBeNull();
    expect(screen.queryByRole("heading", { name: "提出物", level: 2 })).toBeNull();
    expect(screen.queryByRole("button", { name: "予定を編集" })).toBeNull();
  });

  it("pattern2: 盤面の来校者/生徒呼び出しにもクリック編集ボタンを出す（#2 全配線・盤面側）", () => {
    // pattern2 の盤面は来校者一覧 / 生徒呼び出しを持つ。編集モード（editRegions）では予定だけでなく
    // これらにも領域編集ボタンを敷き、盤面クリック → 編集欄ジャンプの対象にする（旧実装は予定/連絡/提出物のみ）。
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={{ ...base(), designPattern: "pattern2" }}
        initialSchedules={[]}
        initialNotices={[]}
        initialAssignments={[]}
      />,
    );
    expect(screen.getByRole("button", { name: "来校者一覧を編集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "生徒呼び出しを編集" })).toBeTruthy();
  });

  it("予定の時限で「その他」を選ぶと自由入力欄が出る（#予定 自由記入）", () => {
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={base()}
        initialSchedules={[{ period: 1, subject: "数学" }]}
        initialNotices={[]}
        initialAssignments={[]}
      />,
    );
    const slot = screen.getByLabelText("1 行目の時限") as HTMLSelectElement;
    // 「その他」option が存在する。
    expect(
      Array.from(slot.options).some((o) => o.textContent === "その他" && o.value === "__custom__"),
    ).toBe(true);
    // 既定は自由入力欄なし。
    expect(screen.queryByLabelText("1 行目の時限（自由入力）")).toBeNull();
    // 「その他」を選ぶと自由入力欄が出る。
    fireEvent.change(slot, { target: { value: "__custom__" } });
    const custom = screen.getByLabelText("1 行目の時限（自由入力）") as HTMLInputElement;
    expect(custom).toBeTruthy();
    fireEvent.change(custom, { target: { value: "補習" } });
    expect((screen.getByLabelText("1 行目の時限（自由入力）") as HTMLInputElement).value).toBe(
      "補習",
    );
  });

  it("pattern2: 盤面の来校者をクリックすると盤面外の編集欄(anchor id)へスクロール+選択状態にする（#2 クロスコンポーネント）", () => {
    render(
      <WysiwygBoardEditor
        classId={CLASS_ID}
        date={TODAY}
        base={{ ...base(), designPattern: "pattern2" }}
        initialSchedules={[]}
        initialNotices={[]}
        initialAssignments={[]}
      />,
    );
    // 来校者の編集欄は親(page.tsx)が盤面の外に出す（VisitorsCalloutsSection）。本単体テストには無いので、
    // ジャンプ先 anchor id を持つ要素を document に注入して代替し、focusRegion が DOM id 経由で到達することを固定する。
    const target = document.createElement("div");
    target.id = "editor-region-visitors";
    const input = document.createElement("input");
    target.appendChild(input);
    document.body.appendChild(target);
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    fireEvent.click(screen.getByRole("button", { name: "来校者一覧を編集" }));

    // 盤面外の編集欄へスクロール + 内部の最初の入力にフォーカス + クリックした領域は選択状態。
    expect(scrollSpy).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(
      screen.getByRole("button", { name: "来校者一覧を編集" }).getAttribute("aria-pressed"),
    ).toBe("true");

    document.body.removeChild(target);
  });
});
