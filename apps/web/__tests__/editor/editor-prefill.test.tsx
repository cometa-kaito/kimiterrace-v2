import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * エディタの「行の事前生成」（`prefillRows`）と空行の扱いを固定する（2026-06-23 要望）。
 *
 * - 盤面の規定枠ぶん空行を最初から並べる（教員が「盤面に出る枠」を入力前から把握できる）。既存入力が
 *   規定枠より多ければ切り詰めない。
 * - 事前生成した空行は**自動保存をブロックしない**（全行空なら idle のまま・"未入力" を出さない・空の予定/連絡を
 *   作らない）。
 * - 1 行だけ埋めると、空行を落として**その 1 件だけ**を保存する。
 *
 * 自動保存フックは実物を走らせ、Server Action は import 時に DB/認可を引き込むため mock する
 * （schedule-editor-nav / wysiwyg-board-editor の各テストと同方式）。
 */

const h = vi.hoisted(() => ({
  push: vi.fn(),
  setScheduleAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  setNoticesAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  setAssignmentsAction: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock("@/lib/editor/schedule-actions", () => ({
  setScheduleAction: (...a: unknown[]) => h.setScheduleAction(...a),
}));
vi.mock("@/lib/editor/notice-assignment-actions", () => ({
  setNoticesAction: (...a: unknown[]) => h.setNoticesAction(...a),
  setAssignmentsAction: (...a: unknown[]) => h.setAssignmentsAction(...a),
}));

import { NoticeEditor } from "../../app/app/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "../../app/app/editor/[classId]/_components/ScheduleEditor";
import type { ScheduleItem } from "../../lib/editor/schedule-core";

const CLASS_ID = "11111111-1111-1111-1111-111111111111";
const DATE = "2026-06-23";

/** save 呼び出し（末尾に targetSchoolId が付く）から保存ペイロード（配列引数）を取り出す。 */
function savedItems(mock: { mock: { calls: unknown[][] } }): unknown[] {
  const call = mock.mock.calls[0] ?? [];
  return (call.find((a) => Array.isArray(a)) as unknown[]) ?? [];
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ScheduleEditor 事前生成（prefillRows）", () => {
  it("prefillRows=5 は既存 0 件でも 5 行ぶん空行を並べる（6 行目は無い）", () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[]}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    expect(screen.getByLabelText("1 行目の科目名")).toBeTruthy();
    expect(screen.getByLabelText("5 行目の科目名")).toBeTruthy();
    expect(screen.queryByLabelText("6 行目の科目名")).toBeNull();
  });

  it("既存 2 件 + prefill 5 → 5 行（既存を先頭に保持し不足 3 行を空行で補う）", () => {
    const initial: ScheduleItem[] = [
      { period: 1, subject: "数学" },
      { period: 2, subject: "国語" },
    ];
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={initial}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    expect((screen.getByLabelText("1 行目の科目名") as HTMLInputElement).value).toBe("数学");
    expect((screen.getByLabelText("2 行目の科目名") as HTMLInputElement).value).toBe("国語");
    expect((screen.getByLabelText("3 行目の科目名") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("5 行目の科目名")).toBeTruthy();
    expect(screen.queryByLabelText("6 行目の科目名")).toBeNull();
  });

  it("既存が規定枠より多ければ切り詰めない（6 件なら 6 行）", () => {
    const initial: ScheduleItem[] = [1, 2, 3, 4, 5, 6].map((p) => ({
      period: p,
      subject: `S${p}`,
    }));
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={initial}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    expect(screen.getByLabelText("6 行目の科目名")).toBeTruthy();
  });
});

describe("ScheduleEditor 事前生成した空行は保存をブロックしない / 落とす", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("全行空のまま時間が経っても保存しない（idle・空の予定を作らない・未入力表示を出さない）", async () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[]}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(h.setScheduleAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/未入力の項目があります/)).toBeNull();
  });

  it("1 行だけ埋めると空行を落として 1 件だけ保存する", async () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[]}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    fireEvent.change(screen.getByLabelText("1 行目の科目名"), { target: { value: "数学" } });
    // 時限は未選択で始まるので選ぶ（選ぶまでは保存されない＝別テストで固定）。
    fireEvent.change(screen.getByLabelText("1 行目の時限"), { target: { value: "1" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.setScheduleAction).toHaveBeenCalledTimes(1);
    const items = savedItems(h.setScheduleAction) as Array<{ subject: string; period: number }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.subject).toBe("数学");
    expect(items[0]?.period).toBe(1);
  });

  it("事前生成行の時限は未選択（空欄）で始まり、科目だけでは保存しない（時限を選ぶと保存）", async () => {
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[]}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    // 事前生成行の時限は未選択（空欄＝1限〜5限 を自動で入れない・要望 2026-06-23）。
    expect((screen.getByLabelText("1 行目の時限") as HTMLSelectElement).value).toBe("");
    // 科目だけ入れて時限が未選択 → 保存しない（時限とセットで盤面に出す現行仕様を維持）。
    fireEvent.change(screen.getByLabelText("1 行目の科目名"), { target: { value: "数学" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.setScheduleAction).not.toHaveBeenCalled();
    // 時限を選ぶと保存される。
    fireEvent.change(screen.getByLabelText("1 行目の時限"), { target: { value: "2" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.setScheduleAction).toHaveBeenCalledTimes(1);
    const items = savedItems(h.setScheduleAction) as Array<{ period: number }>;
    expect(items[0]?.period).toBe(2);
  });

  it("既存 1 件の科目を全消去すると空配列で保存する（中身を空にした＝削除と整合・空行除外の帰結）", async () => {
    // 空行除外（filledRows 基準）により、唯一の既存項目を空にすると保存ペイロードが空配列になり項目が消える。
    // 「削除」ボタンでの空配列保存と整合する意図的挙動。回帰で気付けるよう固定する（Reviewer 指摘）。
    render(
      <ScheduleEditor
        classId={CLASS_ID}
        date={DATE}
        initialItems={[{ period: 1, subject: "数学" }]}
        showDateNav={false}
        prefillRows={5}
      />,
    );
    fireEvent.change(screen.getByLabelText("1 行目の科目名"), { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(h.setScheduleAction).toHaveBeenCalledTimes(1);
    expect(savedItems(h.setScheduleAction)).toHaveLength(0);
  });
});

describe("NoticeEditor 事前生成", () => {
  it("prefillRows=5 は空行 5 行を並べる（6 件目は無い）", () => {
    render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[]} prefillRows={5} />);
    expect(screen.getByLabelText("1 件目の連絡事項")).toBeTruthy();
    expect(screen.getByLabelText("5 件目の連絡事項")).toBeTruthy();
    expect(screen.queryByLabelText("6 件目の連絡事項")).toBeNull();
  });

  it("1 件だけ入力すると空行を落として 1 件保存する", async () => {
    vi.useFakeTimers();
    try {
      render(<NoticeEditor classId={CLASS_ID} date={DATE} initialItems={[]} prefillRows={5} />);
      fireEvent.change(screen.getByLabelText("1 件目の連絡事項"), {
        target: { value: "テスト連絡" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(h.setNoticesAction).toHaveBeenCalledTimes(1);
      const items = savedItems(h.setNoticesAction) as Array<{ text: string }>;
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe("テスト連絡");
    } finally {
      vi.useRealTimers();
    }
  });
});
