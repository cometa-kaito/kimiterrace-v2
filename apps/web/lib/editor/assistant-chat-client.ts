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

/**
 * 拒否理由 → 教員向けの文言（UI shell が表示）。本文/生 PII は含めず、次の操作の手がかりになる短文にする。
 * 純関数（UI 非依存・テスト可能）。`pii_warning` は専用の警告ボックスを出すため通常ここは通らないが網羅する。
 */
export function chatErrorMessage(reason: AssistantChatErrorReason): string {
  switch (reason) {
    case "rate_limited":
      return "混み合っています。少し待ってからもう一度お試しください。";
    case "stream_failed":
      return "応答の生成に失敗しました。もう一度お試しください。";
    case "no_result":
      return "うまくまとめられませんでした。言い方を変えてもう一度お試しください。";
    case "pii_leak":
      return "個人情報が含まれていたため、安全のため中止しました。表現を変えてお試しください。";
    case "pii_warning":
      return "氏名らしき語が含まれています。個人情報にご注意ください。";
    case "empty":
      return "内容を入力してください。";
    case "too_long":
      return "入力が長すぎます。短く分けてお試しください。";
    default:
      return "送信に失敗しました。もう一度お試しください。";
  }
}

/**
 * その拒否理由が「同じ入力のまま再送して解消しうる一時的失敗」か。`true` の理由だけ UI に「再試行」を出す。
 * 一時的（通信/モデル障害・混雑）= 再試行可。入力起因（空/過大/不正）・PII・no_result = 入力を変える必要があり再試行不可。
 */
export function isRetryableError(reason: AssistantChatErrorReason): boolean {
  return reason === "stream_failed" || reason === "rate_limited";
}

/**
 * ユーザーが生成を**中断**したときの状態確定（applyChatFrame の `done` と同型だが draft は差し替えない）。
 * 途中まで届いた応答（streamingText）を assistant ターンへ確定し、途中まで届いた下書き（draft）は保持する。
 * エラー表示はしない（中断はユーザーの意図的操作）。status は `done`（=確認カードで途中下書きを反映/破棄できる）。
 */
export function finalizeInterruptedTurn(state: ChatState): ChatState {
  const trimmed = state.streamingText.trim();
  const messages = trimmed
    ? [...state.messages, { role: "assistant" as const, content: state.streamingText }]
    : state.messages;
  return { ...state, messages, streamingText: "", status: "done", error: null };
}

/**
 * 読み取りループが**終端フレーム（done/error）を受け取らないまま**ストリームが閉じた場合の確定。
 *
 * サーバ/インフラが SSE を途中で切る（Cloud Run のリクエストタイムアウト・プロキシ切断・モデル無応答後の
 * 接続クローズ等）と、クライアントは `done`/`error` を受信できず `status` が `streaming` のまま残り、
 * UI が**永久に「考えています」で固まる**（`streaming && streamingText===""` の表示が消えない）。これを
 * 防ぐため、ループ終了後に `status` がまだ `streaming` なら再試行可能な `stream_failed` に畳む。既に
 * `done`/`error`（終端フレーム受信済み）に達していれば**現状をそのまま返す**（正常完了・既知の拒否を上書きしない）。
 */
export function finalizeUnterminatedTurn(state: ChatState): ChatState {
  if (state.status !== "streaming") {
    return state;
  }
  return { ...state, status: "error", error: { reason: "stream_failed" } };
}

/**
 * 会話開始（最初の送信）直前に、下書きの基底を「**今この瞬間のフォーム状態**」へ再シードする
 * （2026-07-06 P1: AI 反映⇄手入力の非同期データ消失の是正・EditorDraftSyncContext と対）。
 *
 * `initialDraft`（ページロード時スナップショット）だけを基底にすると、ロード後の手入力（自動保存済み）を
 * AI が知らず、反映（per-section 置換保存）が手入力を無警告で消す。会話が始まる前なら下書きは基底そのもの
 * なので、フォームの現在値で安全に差し替えられる。
 *
 * 再シードするのは **未送信（messages 空）かつ status が idle** のときだけ:
 * - 送信済み（messages あり）: 下書きは会話の作業状態＝AI とユーザーの合意形成中。上書きすると会話が壊れる。
 * - status !== "idle": ファイル取り込み（onFile）は messages を積まずに draft を作る（status="done"）。
 *   これを上書きすると取り込み結果が消えるため対象外。
 * `current` が null/undefined（Provider 外・フォーム未初期化）は従来挙動のまま（fail-soft）。
 */
export function rebaseDraftBeforeFirstTurn(
  state: ChatState,
  current: AssistantDraft | null | undefined,
): ChatState {
  if (!current || state.messages.length > 0 || state.status !== "idle") {
    return state;
  }
  return { ...state, draft: current };
}
