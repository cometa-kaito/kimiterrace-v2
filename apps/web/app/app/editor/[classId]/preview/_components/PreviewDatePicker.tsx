"use client";

import { editorPreviewPath } from "@/lib/editor/default-date";
import { tokens } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";

/**
 * 実寸サイネージプレビュー（#1257）の**日付ピッカー**（最小の client 部品）。任意日を選ぶと
 * `?date=YYYY-MM-DD` へソフトナビゲートし、Server Component がその日の盤面を組み直す。状態は持たない
 * （値はサーバ props が単一ソース）。空値（クリア操作）は無視（不正 URL を作らない・fail-soft）。
 * 前日/翌日はサーバ側の `<Link>` が担い、本部品は「遠い日へ一発で飛ぶ」だけを受け持つ。
 */
export function PreviewDatePicker({ classId, date }: { classId: string; date: string }) {
  const router = useRouter();
  return (
    <input
      type="date"
      aria-label="表示する日付"
      value={date}
      onChange={(e) => {
        const next = e.currentTarget.value;
        if (next) {
          router.push(editorPreviewPath(classId, next));
        }
      }}
      style={{
        fontSize: tokens.fontSize.sm,
        color: tokens.color.ink,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: "0.4rem",
        padding: "0.25rem 0.5rem",
        background: "#fff",
      }}
    />
  );
}
