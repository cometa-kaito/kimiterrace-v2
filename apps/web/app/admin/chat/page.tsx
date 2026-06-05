import { ChatPanel } from "@/app/_components/ChatPanel";
import { requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { TEACHER_CHAT_ENDPOINT } from "@/lib/student-qa/chat-client";

/**
 * F06 (#42, #370): 教員 掲示物 Q&A チャット (`/admin/chat`)。**Server Component**。
 *
 * 教員 (認証済) も生徒と同じ掲示物 Q&A bot を使える UI。汎用 {@link ChatPanel} を教員経路
 * ({@link TEACHER_CHAT_ENDPOINT} = `/api/teacher/chat`) に向けてマウントする。
 *
 * **認可 (route と整合, #370)**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え、本ページは
 * `requireRole(PUBLISHER_ROLES)` (school_admin / teacher) に限定する。**system_admin は早期 403**
 * (`/forbidden`) — `/api/teacher/chat` も system_admin を 403 にする (横断ロールで自校 grounding 対象外)
 * ため、nav からも本ページを出さず死リンクを防ぐ。認証/レート制限/RAG/PII マスクは route + chat-service
 * が担う (本ページは UI マウントのみ、ADR-028)。
 */
export default async function TeacherChatPage() {
  await requireRole(PUBLISHER_ROLES);

  return (
    // 読みやすさのため幅は 40rem に抑えるが、左揃え (margin:auto の中央寄せをやめる) にして他の
    // 管理ページと体裁を揃える。fontFamily は body の日本語フォントスタックを継承する (上書きしない)。
    <main style={{ maxWidth: "40rem" }}>
      <h1>掲示物について質問する</h1>
      <p>
        自校の公開中の掲示物に関する質問に AI が回答します。学習・進路の相談には対応していません。
        日時・持ち物など掲示に無い詳細は回答に含めず、原本の確認を案内します。
      </p>
      <ChatPanel
        endpoint={TEACHER_CHAT_ENDPOINT}
        heading="掲示物 Q&A"
        placeholder="例: 文化祭の集合時間はいつですか？"
        emptyHint="自校の掲示物に関する質問を入力して送信してください。"
      />
    </main>
  );
}
