import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * {@link DayEventsPanel}（「この日の行事」ワンクリック確定・ADR-049 決定 7・PR-D）を固定する。
 *
 * - 押下で行事の写像が**既存の per-section 保存 Server Action へ append**（現在項目 + 新規 1 件）されること
 * - 挿入基底は共有 ref（EditorDraftSyncContext）の「今この瞬間のフォーム状態」を優先し、未確立は
 *   サーバ初期値（props）へ fail-soft すること（置換保存が手入力を消す P1 穴の再発防止）
 * - 成功で `?applied=<nonce>` 再ナビ（SeedConfirmButton と同じ確立済み手法・date 固定・scroll:false）が走ること
 * - 失敗時はナビゲーションせずエラーメッセージを出すこと
 * - パターンが該当ブロックを持たないときは追加ボタンを出さないこと（死ボタン防止）
 * - フッタに年間予定表取込（PR-C ページ）への導線契約リンクを持つこと
 */

const replaceMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/app/editor/c1",
  useSearchParams: () => new URLSearchParams("date=2026-07-10"),
}));
vi.mock("../../lib/editor/schedule-actions", () => ({
  setScheduleAction: vi.fn(async () => ({ ok: true, data: { id: "d1" } })),
}));
vi.mock("../../lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: vi.fn(async () => ({ ok: true, data: { id: "d1" } })),
}));

import {
  type EditorCurrentDraft,
  EditorDraftSyncProvider,
  useEditorDraftSyncRef,
} from "../../app/app/editor/_components/EditorDraftSyncContext";
import { DayEventsPanel } from "../../app/app/editor/[classId]/_components/DayEventsPanel";
import type { EditorDayEvent } from "../../lib/editor/day-events";
import { setNoticesAction } from "../../lib/editor/notice-assignment-actions";
import { setScheduleAction } from "../../lib/editor/schedule-actions";

function ev(overrides: Partial<EditorDayEvent> & { id: string }): EditorDayEvent {
  return {
    summary: "体育祭",
    location: null,
    allDay: true,
    timeLabel: null,
    startDate: "2026-07-10",
    endDate: null,
    ...overrides,
  };
}

const FALLBACK_SCHEDULES = [{ period: 1, subject: "国語" }];
const FALLBACK_NOTICES = [{ text: "既存の連絡" }];

function renderPanel(props?: Partial<Parameters<typeof DayEventsPanel>[0]>) {
  return render(
    <DayEventsPanel
      classId="c1"
      date="2026-07-10"
      events={[ev({ id: "e1", summary: "球技大会", location: "体育館", timeLabel: "09:30" })]}
      canAddSchedule={true}
      canAddNotice={true}
      fallbackSchedules={FALLBACK_SCHEDULES}
      fallbackNotices={FALLBACK_NOTICES}
      {...props}
    />,
  );
}

/** 共有 ref（EditorDraftSyncContext）へフォーム現在値を書き込むテスト用の書き手（WysiwygBoardEditor 相当）。 */
function DraftWriter({ draft }: { draft: EditorCurrentDraft }) {
  const ref = useEditorDraftSyncRef();
  useEffect(() => {
    if (ref) {
      ref.current = draft;
    }
  }, [ref, draft]);
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DayEventsPanel（この日の行事・ワンクリック確定）", () => {
  it("行事 0 件は何も描かない（親の非表示と二重防御）", () => {
    const { container } = renderPanel({ events: [] });
    expect(container.innerHTML).toBe("");
  });

  it("「予定へ追加」で 現在の予定 + 行事写像 を setScheduleAction（既存保存経路）へ append し、?applied= 再ナビ", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "予定へ追加" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(setScheduleAction).toHaveBeenCalledWith("class", "c1", "2026-07-10", [
      ...FALLBACK_SCHEDULES,
      { subject: "球技大会", location: "体育館", period: { custom: "09:30" } },
    ]);
    expect(setNoticesAction).not.toHaveBeenCalled();
    const [url, opts] = replaceMock.mock.calls[0] as [string, { scroll: boolean }];
    const params = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("/app/editor/c1?")).toBe(true);
    expect(params.get("date")).toBe("2026-07-10");
    expect(params.get("applied")).toMatch(/^\d+$/);
    expect(opts).toEqual({ scroll: false });
  });

  it("「連絡へ追加」で 現在の連絡 + 「summary＠場所」を setNoticesAction へ append する", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "連絡へ追加" }));

    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(setNoticesAction).toHaveBeenCalledWith("class", "c1", "2026-07-10", [
      ...FALLBACK_NOTICES,
      { text: "球技大会＠体育館" },
    ]);
    expect(setScheduleAction).not.toHaveBeenCalled();
  });

  it("共有 ref（フォームの今この瞬間）があれば props 初期値でなくそれを挿入基底にする（P1 穴の再発防止）", async () => {
    const live: EditorCurrentDraft = {
      schedules: [{ period: 2, subject: "数学（手入力）" }],
      notices: [{ text: "手入力の連絡" }],
      assignments: [],
    };
    render(
      <EditorDraftSyncProvider>
        <DraftWriter draft={live} />
        <DayEventsPanel
          classId="c1"
          date="2026-07-10"
          events={[ev({ id: "e1", summary: "球技大会" })]}
          canAddSchedule={true}
          canAddNotice={true}
          fallbackSchedules={FALLBACK_SCHEDULES}
          fallbackNotices={FALLBACK_NOTICES}
        />
      </EditorDraftSyncProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "予定へ追加" }));
    // 1 回目の遷移（pending 解除）まで待ってから 2 つ目を押す（pending 中はボタンが disabled）。
    await waitFor(() => expect(replaceMock).toHaveBeenCalledTimes(1));
    expect(setScheduleAction).toHaveBeenCalledWith("class", "c1", "2026-07-10", [
      ...live.schedules,
      { subject: "球技大会" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "連絡へ追加" }));
    await waitFor(() => expect(setNoticesAction).toHaveBeenCalledTimes(1));
    expect(setNoticesAction).toHaveBeenCalledWith("class", "c1", "2026-07-10", [
      ...live.notices,
      { text: "球技大会" },
    ]);
  });

  it("保存失敗時はナビゲーションせずエラーメッセージを出す", async () => {
    vi.mocked(setScheduleAction).mockResolvedValueOnce({
      ok: false,
      error: { message: "保存に失敗しました" },
    } as never);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "予定へ追加" }));

    await screen.findByText("保存に失敗しました");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("パターンが該当ブロックを持たなければ追加ボタンを出さない（死ボタン防止）", () => {
    renderPanel({ canAddSchedule: false, canAddNotice: false });
    expect(screen.queryByRole("button", { name: "予定へ追加" })).toBeNull();
    expect(screen.queryByRole("button", { name: "連絡へ追加" })).toBeNull();
    // 行事の表示自体は残る（情報としての価値）。
    expect(screen.getByText("球技大会")).toBeTruthy();
  });

  it("行のメタ（時刻 / 終日 / 期間）と場所を表示し、フッタに年間予定表取込（PR-C）への導線を持つ", () => {
    renderPanel({
      events: [
        ev({ id: "e1", summary: "球技大会", location: "体育館", timeLabel: "09:30" }),
        ev({ id: "e2", summary: "修学旅行", startDate: "2026-07-08", endDate: "2026-07-11" }),
        ev({ id: "e3", summary: "終業式" }),
      ],
    });
    expect(screen.getByText("09:30")).toBeTruthy();
    expect(screen.getByText("＠体育館")).toBeTruthy();
    expect(screen.getByText("7/8〜7/11")).toBeTruthy();
    expect(screen.getByText("終日")).toBeTruthy();
    const link = screen.getByRole("link", { name: "年間予定表を取り込む →" });
    expect(link.getAttribute("href")).toBe("/app/editor/calendar-import");
  });
});
