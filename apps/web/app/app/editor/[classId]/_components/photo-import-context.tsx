"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

/**
 * P1 写真取込（設計 editor-shipping-and-zero-input-2026-07.md §3.2 D5/D6）の**導線 → チャット合流**の
 * 受け渡しコンテキスト。ゾーン1 の取込導線（{@link "./PhotoImportZone"}・planActions 内）と、右下の
 * 浮遊チャット（{@link "./FloatingAiChat"} + EditorChat）は**別サブツリー**にあり、server component の
 * page.tsx は両者間に関数 prop を渡せないため、client context で「OCR 済みチャットターン」を橋渡しする。
 *
 * 流れ: PhotoImportZone が photoImportChatMessageAction の成功結果（注入ターン本文）を submit →
 * FloatingAiChat が pending を見てパネルを開く → ClassEditorChat（EditorChat）が consume して
 * 通常の user ターンとして送信（PII soft-gate / マスク / days 振り分けは既存チャット経路のまま）。
 *
 * pending は 1 件のみ保持（連投は最後勝ち）。consume で必ず null に戻す（StrictMode の効果二重実行でも
 * 二重送信しないよう、消費側は送信ガード → consume → 送信の順で行う）。
 */

type PhotoImportContextValue = {
  /** 取込済みでチャット送信待ちの user ターン本文（無ければ null）。 */
  pendingMessage: string | null;
  /** 導線側: 取込成功したターン本文を積む（チャットが開いて自動送信される）。 */
  submitPhotoMessage: (message: string) => void;
  /** チャット側: 送信に着手したら必ず呼ぶ（pending を破棄）。 */
  consumePhotoMessage: () => void;
};

const PhotoImportContext = createContext<PhotoImportContextValue | null>(null);

export function PhotoImportProvider({ children }: { children: ReactNode }) {
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const value = useMemo<PhotoImportContextValue>(
    () => ({
      pendingMessage,
      submitPhotoMessage: (message: string) => setPendingMessage(message),
      consumePhotoMessage: () => setPendingMessage(null),
    }),
    [pendingMessage],
  );
  return <PhotoImportContext.Provider value={value}>{children}</PhotoImportContext.Provider>;
}

/** Provider 外（scope エディタ・テスト等）では null（導線なし＝従来挙動）。 */
export function usePhotoImport(): PhotoImportContextValue | null {
  return useContext(PhotoImportContext);
}
