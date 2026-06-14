import {
  ASSISTANT_CHAT_EVENTS,
  type AssistantChatErrorReason,
  type AssistantDraft,
  type ChatTurn,
  type DraftSectionKind,
  EMPTY_DRAFT,
  sanitizeDraft,
} from "./assistant-chat-core";

/**
 * 会話型 AI アシスタント（finding 2b）の **クライアント側状態ロジック**（UIレーン）。
 *
 * `assistant-chat-core.ts`（AIレーンの契約・共有型）に対して、UI shell（`EditorChat`）が使う
 * **SSE フレームのパースと会話状態の遷移**を **純関数**で提供する（React 非依存・バックエンド route
 * 無しでも synthetic フレームで単体検証できる）。React コンポーネントはこの core を呼ぶ薄い殻に保つ
 * （schedule-core / assistant-chat-core と同じ「core は純ロジック」方針・ルール3 の型は契約から import）。
 *
 * SSE プロトコル（`event:`/`data:` 行・空行区切り）は契約 doc
 * `docs/architecture/conversational-assistant-api.md` の §SSE に従う。
 */

/** パース済み SSE フレーム（イベント名 + data 文字列）。 */
export type SseFrame = { event: string; data: string };

/**
 * 伸長中の event-stream バッファを **完全なフレーム列 + 未完の残り**に分割する。
 * フレームは空行(`\n\n`)区切り、各フレームは `event: <name>` / `data: <json>` 行を持つ
 * （`data:` は複数行を許容し `\n` 連結・SSE 仕様）。末尾の未完ブロックは `rest` として持ち越す。
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const parts = buffer.split("\n\n");
  // 最後の要素は「次の \n\n が来ていない未完ブロック」なので持ち越す。
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    if (block.trim() === "") {
      continue;
    }
    let event = ASSISTANT_CHAT_EVENTS.message as string;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        // 先頭 1 個の半角スペースのみ剥がす（SSE 仕様）。
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

/** 会話の進行状態。 */
export type ChatStatus = "idle" | "streaming" | "done" | "error";

/** UI shell が描画する会話状態（1 クラスのエディタ AI セッション）。 */
export type ChatState = {
  /** 確定済みターン（user + done で確定した assistant 応答）。次の送信でそのまま messages に使う。 */
  messages: ChatTurn[];
  /** 進行中の assistant 応答（prose・done で messages へ確定）。 */
  streamingText: string;
  /** 構造化下書き（許可セクションのみ・カード描画と盤面プレビューの元）。 */
  draft: AssistantDraft;
  status: ChatStatus;
  /** 実効サイネージパターン（meta で確定・null は未受信）。 */
  pattern: string | null;
  /** このクラスで AI が下書きできるセクション（meta で確定）。 */
  allowedSections: DraftSectionKind[];
  /** 直近の拒否（pii_warning は acknowledge 再送、その他は文言表示）。 */
  error: {
    reason: AssistantChatErrorReason;
    suspectedSurfaces?: string[];
    message?: string;
  } | null;
};

/** 初期状態。既存の下書き（盤面の現状）をシードできる。 */
export function initialChatState(draft: AssistantDraft = EMPTY_DRAFT): ChatState {
  return {
    messages: [],
    streamingText: "",
    draft,
    status: "idle",
    pattern: null,
    allowedSections: [],
    error: null,
  };
}

/** ユーザー送信の開始: user ターンを積み、ストリーミング開始・前回エラーをクリア。 */
export function beginUserTurn(state: ChatState, content: string): ChatState {
  return {
    ...state,
    messages: [...state.messages, { role: "user", content }],
    streamingText: "",
    status: "streaming",
    error: null,
  };
}

/**
 * SSE フレーム 1 個を状態に適用する（meta/message/draft/error/done）。
 * - `data` が壊れた JSON のフレームは**無視**して現状を返す（fail-soft・盤面/入力を失わない）。
 * - `done` で進行中 prose を assistant ターンへ確定し、`draft` を確定スナップショットに置換する。
 * - `error` は status=error にし入力・下書きは保持（pii_warning は acknowledge 再送、`suspectedSurfaces` 表示）。
 */
export function applyChatFrame(state: ChatState, frame: SseFrame): ChatState {
  let data: unknown;
  try {
    data = frame.data ? JSON.parse(frame.data) : {};
  } catch {
    return state;
  }
  const rec = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;

  switch (frame.event) {
    case ASSISTANT_CHAT_EVENTS.meta:
      return {
        ...state,
        pattern: typeof rec.pattern === "string" ? rec.pattern : state.pattern,
        allowedSections: Array.isArray(rec.allowedSections)
          ? (rec.allowedSections.filter((s) => typeof s === "string") as DraftSectionKind[])
          : state.allowedSections,
      };
    case ASSISTANT_CHAT_EVENTS.message:
      return typeof rec.delta === "string"
        ? { ...state, streamingText: state.streamingText + rec.delta }
        : state;
    case ASSISTANT_CHAT_EVENTS.draft:
      // 許可セクションへの最終フィルタはサーバが行うが、client も契約型へ防御正規化する。
      return { ...state, draft: sanitizeDraft(data) };
    case ASSISTANT_CHAT_EVENTS.error:
      return {
        ...state,
        status: "error",
        error: {
          reason: (typeof rec.reason === "string"
            ? rec.reason
            : "stream_failed") as AssistantChatErrorReason,
          suspectedSurfaces: Array.isArray(rec.suspectedSurfaces)
            ? (rec.suspectedSurfaces.filter((s) => typeof s === "string") as string[])
            : undefined,
          message: typeof rec.message === "string" ? rec.message : undefined,
        },
      };
    case ASSISTANT_CHAT_EVENTS.done: {
      const finalDraft = rec.draft !== undefined ? sanitizeDraft(rec.draft) : state.draft;
      const trimmed = state.streamingText.trim();
      const messages = trimmed
        ? [...state.messages, { role: "assistant" as const, content: state.streamingText }]
        : state.messages;
      return { ...state, messages, streamingText: "", draft: finalDraft, status: "done" };
    }
    default:
      return state;
  }
}
