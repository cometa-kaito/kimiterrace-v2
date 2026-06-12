"use client";

import { useEffect } from "react";

/** 「前回のクラスを再開」用 cookie 名（エディタ着地 `/admin/editor` が読む）。 */
export const LAST_CLASS_COOKIE = "kt_last_class";

/**
 * 最後に開いたクラスを cookie に記録する（UIUX-02: 毎回の範囲選択ホップ削減）。
 *
 * - 値は classId（UUID）のみ。読む側（エディタ着地）は RLS スコープ済みの自校階層と突合してから
 *   リンクを出すため、改竄・失効済みの値が他校や 404 へ誘導することはない。
 * - 認証情報ではない UX 補助 cookie。Server Component の描画中は cookie を書けないため、
 *   client で document.cookie に書くのが最小工数（httpOnly 不要）。
 */
export function RememberLastClass({ classId }: { classId: string }) {
  useEffect(() => {
    const maxAge = 60 * 60 * 24 * 180; // 180日
    // biome-ignore lint/suspicious/noDocumentCookie: クライアント側のUX補助cookie(非機密のclassIdのみ・httpOnly不要)。Server Component描画中はcookie不可ゆえclientで書く。読む側がRLSスコープ自校階層と突合(改竄無効化)。
    document.cookie = `${LAST_CLASS_COOKIE}=${encodeURIComponent(classId)}; path=/admin; max-age=${maxAge}; samesite=lax`;
  }, [classId]);
  return null;
}
