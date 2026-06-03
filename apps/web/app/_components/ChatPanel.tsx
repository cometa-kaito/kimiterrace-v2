"use client";

import { type ChatEvent, streamChat } from "@/lib/student-qa/chat-client";
import { type FormEvent, useCallback, useId, useRef, useState } from "react";

/**
 * F06 (#42, #371/#370): 掲示物 Q&A チャットの **汎用 UI コンポーネント**。**Client Component**。
 *
 * 生徒 (`/api/student/chat`, #371) と教員 (`/api/teacher/chat`, #370) の両 UI で共有する。`endpoint` と
 * 表示文言だけを prop で差し替え、SSE 受信・逐次表示・エラー処理・アクセシビリティ (WCAG 2.2 AA / NFR05)
 * は単一実装にする。`streamChat` (chat-client.ts) 経由で SSE route を呼ぶ。
 *
 * **認証 (#371/#370)**: 本コンポーネントは **トークンや user_id を一切扱わない**。認証は各 SSE route が
 * cookie (`__student_session`) / Identity Platform セッションをサーバ側で解決する。`streamChat` は
 * `credentials:"same-origin"` で認証 cookie を自動送信し、本体は質問のみ (F05 トークン秘匿維持、ルール5)。
 *
 * **多言語 (#371, ADR-028)**: ロール/送信/エラー文言は共有定数、見出し等は prop。本スライスは日本語のみ
 * 出荷 (i18n フレームワーク未導入)。サーバ提供の `error.message` (refusal/rate-limit、refusal.ts で多言語化済)
 * はそのまま表示する。PII マスキングはサーバ (chat-service) の責務。
 *
 * 関連: chat-client.ts, sse-handler.ts, ADR-006 (SSE), ADR-028 (回答ポリシー), NFR05 (a11y)。
 */

/** 共有 UI 文言 (ロール/操作/エラー)。経路非依存。 */
const STR = {
  inputLabel: "質問を入力",
  send: "送信",
  sending: "送信中…",
  roleUser: "あなた",
  roleAssistant: "アシスタント",
  errors: {
    // 生徒経路 (magic_link 失効 = 410 gone)。
    gone: "このアクセスリンクは無効か期限切れです。担任の先生に新しいリンクの発行を依頼してください。",
    // 教員経路 (未認証 401 / 権限不足 403)。magic_link 文言は教員に不適切なので分ける (#370 Reviewer nit)。
    accessDenied: "アクセス権限がありません。お手数ですが、再度ログインしてからお試しください。",
    invalidBody: "質問を入力してください。",
    network: "通信に失敗しました。電波の良い場所でもう一度お試しください。",
    generic: "応答できませんでした。もう一度お試しください。",
  },
} as const;

type ChatRole = "user" | "assistant";
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
    case "unauthenticated":
    case "forbidden":
      return STR.errors.accessDenied;
    case "invalid_body":
    case "invalid_json":
      return STR.errors.invalidBody;
    default:
      return STR.errors.generic;
  }
}

export interface ChatPanelProps {
  /** 投稿先 SSE エンドポイント (`/api/student/chat` | `/api/teacher/chat`)。 */
  endpoint: string;
  /** セクション見出し。 */
  heading: string;
  /** 入力欄プレースホルダ。 */
  placeholder: string;
  /** 会話ログが空のときのヒント文。 */
  emptyHint: string;
}

export function ChatPanel({ endpoint, heading, placeholder, emptyHint }: ChatPanelProps) {
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
      setMessages((prev) => [...prev, { id: nextId(), role: "user", text: question }]);
      setIsStreaming(true);

      let accumulated = "";
      try {
        for await (const ev of streamChat({ question, endpoint })) {
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
    [endpoint, input, isStreaming, nextId],
  );

  const sendDisabled = isStreaming || input.trim() === "";

  return (
    <section aria-labelledby={headingId} className="chat-panel">
      <h2 id={headingId}>{heading}</h2>

      {/* 会話ログ。各メッセージは話者ラベル付き。 */}
      <ol aria-label="会話" className="chat-panel__log">
        {messages.length === 0 && !isStreaming ? (
          <li className="chat-panel__hint">{emptyHint}</li>
        ) : null}
        {messages.map((m) => (
          <li key={m.id} className={`chat-panel__msg chat-panel__msg--${m.role}`}>
            <span className="chat-panel__role">
              {m.role === "user" ? STR.roleUser : STR.roleAssistant}
            </span>
            <span className="chat-panel__text">{m.text}</span>
          </li>
        ))}
      </ol>

      {/* ストリーミング中の部分応答。aria-live で逐次読み上げ (WCAG 2.2 AA)。 */}
      <div aria-live="polite" aria-atomic="false" className="chat-panel__streaming">
        {isStreaming && streamingText !== "" ? (
          <p className="chat-panel__msg chat-panel__msg--assistant">
            <span className="chat-panel__role">{STR.roleAssistant}</span>
            <span className="chat-panel__text">{streamingText}</span>
          </p>
        ) : null}
      </div>

      {/* エラーは role=alert で即時通知。 */}
      {error !== null ? (
        <p role="alert" className="chat-panel__error">
          {error}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="chat-panel__form">
        <label htmlFor={inputId}>{STR.inputLabel}</label>
        <input
          id={inputId}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder}
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
