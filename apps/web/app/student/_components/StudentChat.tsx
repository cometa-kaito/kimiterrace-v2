"use client";

import { ChatPanel } from "@/app/_components/ChatPanel";
import { STUDENT_CHAT_ENDPOINT } from "@/lib/student-qa/chat-client";

/**
 * F06 (#42, #371): 生徒チャット UI。**Client Component**。汎用 {@link ChatPanel} の生徒向け薄ラッパ。
 *
 * 生徒経路 (`/api/student/chat`, #371) に固定し、生徒向けの文言を与える。認証は SSE route が httpOnly
 * cookie `__student_session` をサーバ側で再解決する (本コンポーネントはトークン非保持、F05 秘匿維持)。
 * `/student` ランディングにマウントされる。
 */
export function StudentChat() {
  return (
    <ChatPanel
      endpoint={STUDENT_CHAT_ENDPOINT}
      heading="掲示物について質問する"
      placeholder="例: 体育祭の持ち物は何ですか？"
      emptyHint="掲示物に関する質問を入力して送信してください。"
    />
  );
}
