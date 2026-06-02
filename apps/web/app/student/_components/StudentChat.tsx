"use client";

import { type ChatEvent, streamChat } from "@/lib/student-qa/chat-client";
import { type FormEvent, useCallback, useId, useRef, useState } from "react";

/**
 * F06 (#42, #371): 生徒チャット UI コンポーネント。**Client Component**。
 *
 * `streamChat` (chat-client.ts, #371) 経由で SSE route (`/api/student/chat`, #371) を呼び、掲示物 Q&A の
 * 応答を **逐次表示**する。WCAG 2.2 AA / NFR05 を満たすアクセシブルなチャット UX を提供する。
 *
 * **認証 (#371)**:
 * - **トークンは prop で受け取らない**。生徒の magic link は F05 で httpOnly cookie `__student_session`
 *   に格納済みで、`streamChat` → `/api/student/chat` がサーバ側で cookie を再解決する。本コンポーネントは
 *   生トークンに一切触れず (URL/JS にトークンを出さない、F05 秘匿維持)、`/student` ページにそのまま
 *   マウントできる。質問送信に必要な cookie は `credentials:"same-origin"` で自動送信される。
 *
 * **このスライスの境界 (正直に明記)**:
 * - **多言語 (#371, ADR-028)**: 文言は {@link STR} に集約し i18n-ready にしてあるが、本スライスは
 *   日本語のみ出荷 (リポジトリに i18n フレームワーク未導入)。辞書差し替えは follow-up。サーバ提供の
 *   `error.message` (refusal/rate-limit 等、refusal.ts で多言語化済) はそのまま表示する。
 * - PII マスキングはサーバ (chat-service) の責務。本コンポーネントは質問を送り応答を表示するのみ。
 *
 * 関連: chat-client.ts (#371), route.ts (`/api/student/chat`, #371), ADR-006 (SSE), ADR-028 (回答ポリシー),
 * ADR-016 (magic link), NFR05 (a11y)。
 */

/** UI 文言 (i18n-ready: 多言語スライスで辞書に差し替える)。 */
const STR = {
  heading: "掲示物について質問する",
  inputLabel: "質問を入力",
  placeholder: "例: 体育祭の持ち物は何ですか？",
  send: "送信",
  sending: "送信中…",
  roleStudent: "あなた",
  roleAssistant: "アシスタント",
  emptyHint: "掲示物に関する質問を入力して送信してください。",
  errors: {
    gone: "このアクセスリンクは無効か期限切れです。先生に新しいリンクの発行を依頼してください。",
    invalidBody: "質問を入力してください。",
    network: "通信に失敗しました。電波の良い場所でもう一度お試しください。",
    generic: "応答できませんでした。もう一度お試しください。",
  },
} as const;

type ChatRole = "student" | "assistant";
interface ChatMessage {
  id: number;
  role: ChatRole;
  text: string;
}

/** SSE の error イベントを表示用メッセージに変換。サーバ提供 message を優先 (多言語化済)。 */
function errorMessage(ev: Extract<ChatEvent, { type: "error" }>): string {
  if (ev.message) return ev.message;
  switch (ev.reason) {
    case "gone":
      return STR.errors.gone;
    case "invalid_body":
    case "invalid_json":
      return STR.errors.invalidBody;
    default:
      return STR.errors.generic;
  }
}

export function StudentChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const idRef = useRef(0);
  const headingId = useId();
  const inputId = useId();

  const nextId = useCallback(() => {
    idRef.current += 1;
    return idRef.current;
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const question = input.trim();
      if (question === "" || isStreaming) return;

      setError(null);
      setInput("");
      setMessages((prev) => [...prev, { id: nextId(), role: "student", text: question }]);
      setIsStreaming(true);

      let accumulated = "";
      try {
        for await (const ev of streamChat({ question })) {
          if (ev.type === "delta") {
            accumulated += ev.text;
            setStreamingText(accumulated);
          } else if (ev.type === "error") {
            setError(errorMessage(ev));
          }
          // done: ループ終了で確定 (下記 finally)。
        }
      } catch {
        setError(STR.errors.network);
      } finally {
        if (accumulated !== "") {
          setMessages((prev) => [...prev, { id: nextId(), role: "assistant", text: accumulated }]);
        }
        setStreamingText("");
        setIsStreaming(false);
      }
    },
    [input, isStreaming, nextId],
  );

  const sendDisabled = isStreaming || input.trim() === "";

  return (
    <section aria-labelledby={headingId} className="student-chat">
      <h2 id={headingId}>{STR.heading}</h2>

      {/* 会話ログ。各メッセージは話者ラベル付き。 */}
      <ol aria-label="会話" className="student-chat__log">
        {messages.length === 0 && !isStreaming ? (
          <li className="student-chat__hint">{STR.emptyHint}</li>
        ) : null}
        {messages.map((m) => (
          <li key={m.id} className={`student-chat__msg student-chat__msg--${m.role}`}>
            <span className="student-chat__role">
              {m.role === "student" ? STR.roleStudent : STR.roleAssistant}
            </span>
            <span className="student-chat__text">{m.text}</span>
          </li>
        ))}
      </ol>

      {/* ストリーミング中の部分応答。aria-live で逐次読み上げ (WCAG 2.2 AA)。 */}
      <div aria-live="polite" aria-atomic="false" className="student-chat__streaming">
        {isStreaming && streamingText !== "" ? (
          <p className="student-chat__msg student-chat__msg--assistant">
            <span className="student-chat__role">{STR.roleAssistant}</span>
            <span className="student-chat__text">{streamingText}</span>
          </p>
        ) : null}
      </div>

      {/* エラーは role=alert で即時通知。 */}
      {error !== null ? (
        <p role="alert" className="student-chat__error">
          {error}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="student-chat__form">
        <label htmlFor={inputId}>{STR.inputLabel}</label>
        <input
          id={inputId}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={STR.placeholder}
          disabled={isStreaming}
          autoComplete="off"
          maxLength={500}
        />
        <button type="submit" disabled={sendDisabled} aria-busy={isStreaming}>
          {isStreaming ? STR.sending : STR.send}
        </button>
      </form>
    </section>
  );
}
