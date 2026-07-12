import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 年間行事取込・ステップ1「ファイルを選ぶ」のドロップゾーン UI（教員 FB「このUIもこだわりましょう」
 * #1259 follow-up）の固定テスト。
 *
 * - ネイティブ file input は視覚的に隠し（「選択されていません」を見せない）、大きなドロップゾーン
 *   （実体 = button・クリック/Enter/Space でファイル選択ダイアログ）に置き換える。
 * - クライアント側の即時検証: 対応外拡張子 / 10MB 超過は role=alert の親切なエラー。複数ファイルは
 *   先頭 1 件のみ + その旨を明示（サーバ側検証が最終防衛・ここは早期エラーのみ）。
 * - 選択後は「種類アイコン + ファイル名 + サイズ + 変更 + 取り消し」のカード表示。
 * - 「このファイルを AI で読み取る」はファイル未選択時 disabled + 理由ヒント。
 * - D&D は jsdom で完全再現できないためスモークのみ（drop / dragEnter の文言切替）。
 *   実ブラウザの見た目・ドラッグ挙動は手動確認。
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

import { CalendarImportClient } from "../../app/app/editor/calendar-import/_components/CalendarImportClient";
import type { FileImportedEventSummary } from "../../lib/editor/calendar-import-diff";

const ZONE_NAME = "年間行事予定表ファイルを選ぶ（クリックで選択・ドラッグ＆ドロップ対応）";
const INPUT_LABEL = "年間行事予定表ファイル";
const READ_LABEL = "このファイルを AI で読み取る";
const CANCEL_LABEL = "ファイルの選択を取り消す";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderClient(
  props: { existingFileEvents?: FileImportedEventSummary[]; existingFileName?: string | null } = {},
) {
  return render(
    <CalendarImportClient
      existingFileEvents={props.existingFileEvents ?? []}
      existingFileName={props.existingFileName ?? null}
    />,
  );
}

/** 指定サイズのダミー File（中身を実確保せず size だけ偽装・巨大バッファでテストを重くしない）。 */
function makeFile(name: string, size: number): File {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("ドロップゾーン（未選択時）", () => {
  it("ゾーン（button）と形式/上限の説明が aria-describedby で紐づき、読み取りボタンは disabled + ヒント", () => {
    renderClient();
    const zone = screen.getByRole("button", { name: ZONE_NAME });
    const desc = document.getElementById(zone.getAttribute("aria-describedby") ?? "");
    expect(desc?.textContent).toContain("Excel (.xlsx)");
    expect(desc?.textContent).toContain("上限 10MB");
    expect(screen.getByText("ファイルをドラッグ＆ドロップ")).toBeTruthy();
    expect(screen.getByText("または クリックして選択")).toBeTruthy();

    const read = screen.getByRole("button", { name: READ_LABEL }) as HTMLButtonElement;
    expect(read.disabled).toBe(true);
    expect(read.getAttribute("aria-describedby")).toBe("calendar-import-read-hint");
    expect(screen.getByText("ファイルを選ぶと読み取りを開始できます。")).toBeTruthy();
  });

  it("ゾーンのクリックで隠しファイル input の選択ダイアログを開く（クリック経路が主）", () => {
    renderClient();
    const input = screen.getByLabelText(INPUT_LABEL) as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: ZONE_NAME }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("dragEnter で文言が「ここにドロップして読み込む」に切り替わり、dragLeave で戻る", () => {
    renderClient();
    const zone = screen.getByRole("button", { name: ZONE_NAME });
    fireEvent.dragEnter(zone);
    expect(screen.getByText("ここにドロップして読み込む")).toBeTruthy();
    fireEvent.dragLeave(zone);
    expect(screen.getByText("ファイルをドラッグ＆ドロップ")).toBeTruthy();
  });
});

describe("ファイル選択と検証", () => {
  it("input で選択すると選択済みカード（名前 + 種類 + KB サイズ）になり、読み取りボタンが有効化", () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), {
      target: { files: [makeFile("annual.xlsx", 2048)] },
    });
    // ゾーンはカードに置き換わる。
    expect(screen.queryByRole("button", { name: ZONE_NAME })).toBeNull();
    expect(screen.getByText("annual.xlsx")).toBeTruthy();
    expect(screen.getByText("Excel・2 KB")).toBeTruthy();
    const read = screen.getByRole("button", { name: READ_LABEL }) as HTMLButtonElement;
    expect(read.disabled).toBe(false);
    expect(screen.queryByText("ファイルを選ぶと読み取りを開始できます。")).toBeNull();
  });

  it("サイズは 1MB 以上なら MB 表記", () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), {
      target: { files: [makeFile("annual.pdf", Math.round(1.5 * 1024 * 1024))] },
    });
    expect(screen.getByText("PDF・1.5 MB")).toBeTruthy();
  });

  it("「取り消し」（×）で選択を外しゾーンへ戻る・「変更」で選択ダイアログを開き直す", () => {
    renderClient();
    const input = screen.getByLabelText(INPUT_LABEL) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile("annual.xlsx", 100)] } });

    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "変更" }));
    expect(clickSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: CANCEL_LABEL }));
    expect(screen.getByRole("button", { name: ZONE_NAME })).toBeTruthy();
    expect(screen.queryByText("annual.xlsx")).toBeNull();
    expect((screen.getByRole("button", { name: READ_LABEL }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("対応外拡張子は即時エラー（role=alert）で選択しない", () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), {
      target: { files: [makeFile("memo.docx", 100)] },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "「memo.docx」は対応していない形式です",
    );
    // ゾーンのまま = ファイルは採用されない・読み取りも不可。
    expect(screen.getByRole("button", { name: ZONE_NAME })).toBeTruthy();
    expect((screen.getByRole("button", { name: READ_LABEL }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("10MB 超過は即時エラー（role=alert・実サイズ入り）で選択しない", () => {
    renderClient();
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), {
      target: { files: [makeFile("big.pdf", 11 * 1024 * 1024)] },
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("「big.pdf」は大きすぎます（上限 10MB");
    expect(alert.textContent).toContain("11.0 MB");
    expect(screen.getByRole("button", { name: ZONE_NAME })).toBeTruthy();
  });
});

describe("ドラッグ＆ドロップ（jsdom スモーク）", () => {
  it("drop で選択済みカードになる（クリック選択と同じ検証を通る）", () => {
    renderClient();
    fireEvent.drop(screen.getByRole("button", { name: ZONE_NAME }), {
      dataTransfer: { files: [makeFile("annual.csv", 512)] },
    });
    expect(screen.getByText("annual.csv")).toBeTruthy();
    expect(screen.getByText("CSV・1 KB")).toBeTruthy();
  });

  it("複数ファイルの drop は先頭 1 件のみ採用し、その旨を role=status で明示", () => {
    renderClient();
    fireEvent.drop(screen.getByRole("button", { name: ZONE_NAME }), {
      dataTransfer: { files: [makeFile("a.xlsx", 10), makeFile("b.xlsx", 10)] },
    });
    expect(screen.getByText("a.xlsx")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("先頭の「a.xlsx」だけを選択しました");
    expect(screen.queryByText("b.xlsx")).toBeNull();
  });

  it("drop した対応外ファイルも即時エラー", () => {
    renderClient();
    fireEvent.drop(screen.getByRole("button", { name: ZONE_NAME }), {
      dataTransfer: { files: [makeFile("virus.exe", 10)] },
    });
    expect(screen.getByRole("alert").textContent).toContain("対応していない形式");
    expect(screen.getByRole("button", { name: ZONE_NAME })).toBeTruthy();
  });
});

describe("取込済みバナー", () => {
  it("取込済みがあるとき info バナーで件数・ファイル名・保存時の選択肢を示す", () => {
    renderClient({
      existingFileEvents: [
        { summary: "体育祭", startDate: "2026-06-10", endDate: null, location: null },
      ],
      existingFileName: "prev.xlsx",
    });
    expect(screen.getByText(/取込済み: 今年度の行事 1 件（prev\.xlsx）/)).toBeTruthy();
  });

  it("取込済みが無ければバナーは出ない", () => {
    renderClient();
    expect(screen.queryByText(/取込済み:/)).toBeNull();
  });
});
