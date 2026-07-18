import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * P1 写真取込（D6）: 写真取込導線が注入ターンを積んだら、閉じている FloatingAiChat パネルが
 * **自動で開く**ことを固定する。localStorage には触れない（サイズ永続は floating-ai-chat.test.tsx が
 * 担当）。Provider 外では従来挙動（閉じたまま）であることも合わせて固定する。
 */

import { FloatingAiChat } from "../../app/app/editor/[classId]/_components/FloatingAiChat";
import {
  PhotoImportProvider,
  usePhotoImport,
} from "../../app/app/editor/[classId]/_components/photo-import-context";

/** 導線（PhotoImportZone）の代役: ボタン押下で注入ターンを積む。 */
function SubmitProbe() {
  const ctx = usePhotoImport();
  return (
    <button type="button" onClick={() => ctx?.submitPhotoMessage("【プリント本文】テスト")}>
      写真を取り込んだ
    </button>
  );
}

afterEach(cleanup);

describe("FloatingAiChat × 写真取込の自動オープン", () => {
  it("pending が積まれたらパネルが開く（FAB が消え、パネルが表示される）", () => {
    render(
      <PhotoImportProvider>
        <FloatingAiChat>
          <div data-testid="chat-body" />
        </FloatingAiChat>
        <SubmitProbe />
      </PhotoImportProvider>,
    );
    // 既定は閉（FAB が見える）。
    expect(screen.getByRole("button", { name: "AIで作る" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "写真を取り込んだ" }));
    // 開くと FAB は消え、パネル（閉じるボタン）が現れる。
    expect(screen.queryByRole("button", { name: "AIで作る" })).toBeNull();
    expect(screen.getByRole("button", { name: /閉じる/ })).toBeTruthy();
  });

  it("Provider 外では従来どおり閉じたまま（既存利用への影響なし）", () => {
    render(
      <FloatingAiChat>
        <div />
      </FloatingAiChat>,
    );
    expect(screen.getByRole("button", { name: "AIで作る" })).toBeTruthy();
  });
});
