import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FloatingAiChat } from "../../app/app/editor/[classId]/_components/FloatingAiChat";

/**
 * 右下に浮く AI 支援チャット（FAB + パネル）の開閉・フォーカス・children 表示を固定する。
 *
 * タブ shell 廃止 (2026-06-16) で AI は浮遊チャットに格下げされた。本ラッパは開閉と a11y だけを担い、会話・
 * 保存・SSE は children (EditorChat) が温存する。よってここでは「FAB を押すとパネルが開く / × と Esc で閉じる /
 * 開くとパネル内へフォーカスが移る / children は常時マウントされ display で出し分ける」を検証する。
 */

afterEach(cleanup);

describe("FloatingAiChat", () => {
  it("既定は閉じており FAB を出し、children はマウントされたまま非表示（display:none）", () => {
    render(
      <FloatingAiChat>
        <button type="button">中身ボタン</button>
      </FloatingAiChat>,
    );
    // FAB は既定ラベルで出る。
    expect(screen.getByRole("button", { name: "AIで作る" })).toBeTruthy();
    // children は閉じている間もマウントされている（途中の会話・下書きを失わないため）。
    const child = screen.getByRole("button", { name: "中身ボタン", hidden: true });
    expect(child).toBeTruthy();
    // パネル（dialog）は display:none で非表示。
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect((dialog as HTMLElement).style.display).toBe("none");
  });

  it("FAB を押すとパネルが開き、children が表示され、開いた直後はパネル内へフォーカスが移る", () => {
    render(
      <FloatingAiChat>
        <button type="button">中身ボタン</button>
      </FloatingAiChat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AIで作る" }));
    // パネル（dialog）が visible になり、閉じるボタンが出る。
    const dialog = screen.getByRole("dialog");
    expect((dialog as HTMLElement).style.display).not.toBe("none");
    expect(screen.getByRole("button", { name: "AI チャットを閉じる" })).toBeTruthy();
    // 開くとパネル内の最初の操作対象（閉じるボタン）へフォーカスが移る（a11y）。
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "AI チャットを閉じる" }),
    );
    // 開いている間は FAB を隠す（閉じる導線は × に一本化）。
    expect(screen.queryByRole("button", { name: "AIで作る" })).toBeNull();
  });

  it("× ボタンで閉じる（FAB が戻る・パネルは非表示）", () => {
    render(
      <FloatingAiChat>
        <button type="button">中身ボタン</button>
      </FloatingAiChat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AIで作る" }));
    fireEvent.click(screen.getByRole("button", { name: "AI チャットを閉じる" }));
    expect(screen.getByRole("button", { name: "AIで作る" })).toBeTruthy();
    expect((screen.getByRole("dialog", { hidden: true }) as HTMLElement).style.display).toBe(
      "none",
    );
  });

  it("Esc キーで閉じる", () => {
    render(
      <FloatingAiChat>
        <button type="button">中身ボタン</button>
      </FloatingAiChat>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AIで作る" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("button", { name: "AIで作る" })).toBeTruthy();
    expect((screen.getByRole("dialog", { hidden: true }) as HTMLElement).style.display).toBe(
      "none",
    );
  });

  it("FAB ラベル・パネル見出しは props で差し替えられ、既定では別文言（ロケータ二重化を避ける）", () => {
    render(
      <FloatingAiChat label="AIに相談" title="AI 支援チャット">
        <span>子</span>
      </FloatingAiChat>,
    );
    expect(screen.getByRole("button", { name: "AIに相談" })).toBeTruthy();
    // 見出しはパネル（既定は非表示でも DOM 上に存在）。
    expect(screen.getByRole("heading", { name: "AI 支援チャット", hidden: true })).toBeTruthy();
  });
});
