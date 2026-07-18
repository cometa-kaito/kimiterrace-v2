"use client";

import { EditorChat } from "@/app/app/editor/_components/EditorChat";
import type { PinnedNoticeRow } from "@/lib/editor/notice-assignment-core";
import type { AssistantDraft } from "@/lib/editor/assistant-chat-core";
import type { AssignmentDeadlineFormat } from "@/lib/signage/assignment-deadline-format";
import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * クラスエディタ用の {@link EditorChat} 薄ラッパー。**反映（全件成功）後に `?applied=<nonce>` を付けて
 * 再ナビゲート**し、page.tsx がフォーム側（WysiwygBoardEditor）の key に nonce を含めることで、
 * 各セクション編集器を**反映後データで確実に再マウント**する（コピーの `?copied=` と同じ確立済み手法・
 * CopyFromMenu の docstring 参照）。
 *
 * ## なぜ必要か（2026-07-06 P1・本番で実証したデータ消失）
 * AI の反映は Server Action（置換保存）だが、フォーム（ScheduleEditor 等）の `useState(initial…)` は
 * 再マウントされず**古いまま**だった。結果:
 * 1. 反映後もフォーム・盤面プレビューが変わらず「反映しました」と画面が矛盾（リロードまで見えない）
 * 2. その古いフォームに 1 文字でも入力すると自動保存（置換）が **AI 反映分を上書き消去**
 *    （実証: AI で入れた「1限 英語」が手入力「2限 体育」の自動保存で消えた）
 *
 * ## なぜ EditorChat 本体にナビゲーションを入れないか
 * EditorChat は scope エディタ（学校/学科/学年）と共用で、next/navigation フックを本体に入れると
 * 全利用箇所・全テストに router モックを強いる。副作用（再ナビ）は**クラスエディタだけが注文する**ので、
 * ここ（client ラッパー）で `onApplied` として注入する（server の page.tsx は関数 prop を渡せない）。
 *
 * key（`${date}:${copied}`）は親（page.tsx）が付ける。**applied は EditorChat の key に含めない**＝
 * 反映後も会話・パネル開閉状態を保つ（チャット自身の差分基準は onApply 内で更新済み）。
 */
export function ClassEditorChat({
  classId,
  date,
  pattern,
  assignmentDeadlineFormat,
  initialDraft,
  pinnedNotices,
}: {
  classId: string;
  date: string;
  pattern: SignageDesignPattern;
  /** 提出物の期日表示形式（#1258 学校別設定）。下書きプレビューの表記を実機盤面と一致させる。 */
  assignmentDeadlineFormat: AssignmentDeadlineFormat;
  initialDraft: AssistantDraft;
  pinnedNotices: PinnedNoticeRow[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onApplied = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    // 反映を適用した対象日を明示して固定する（?date 無指定のまま cutover（下校時刻）を跨ぐと既定対象日が
    // 翌授業日へ再解決され「反映が消えた」ように見える・CopyFromMenu と同じ理由）。
    params.set("date", date);
    params.set("applied", String(Date.now()));
    // scroll: false = 画面位置を保つ（チャットパネルを開いたまま反映結果が盤面・フォームに現れる）。
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams, date]);

  return (
    <EditorChat
      scope="class"
      targetId={classId}
      date={date}
      pattern={pattern}
      assignmentDeadlineFormat={assignmentDeadlineFormat}
      initialDraft={initialDraft}
      pinnedNotices={pinnedNotices}
      variant="floating"
      onApplied={onApplied}
    />
  );
}
