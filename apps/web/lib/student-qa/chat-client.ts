/**
 * F06 (#42, #371): 生徒チャット UI 用の **SSE クライアント**。
 *
 * `POST /api/student/chat` (route.ts, #371) を呼び、サーバが返す**名前付き SSE フレーム**
 * (`event: delta|error|done`) を解析して UI 向けの型付きイベント {@link ChatEvent} を逐次 yield する。
 * 認証は **httpOnly cookie `__student_session`** をサーバ側で再解決する経路で、本クライアントは生 magic
 * link トークンに一切触れない (F05 のトークン秘匿設計を維持、credential を URL/JS/ログに出さない)。
 *
 * - **POST + ストリーム読取**: 質問はリクエストボディなので `EventSource` (GET 専用) は使えない。
 *   `fetch` + `ReadableStream` リーダで自前にフレームを解析する。
 * - **2 種の拒否を 1 経路に正規化**: route は無効トークン (410 `{error:"gone"}`) と不正ボディ
 *   (400 `{error}`) を **SSE を開く前**に非 200 JSON で返し、validate/rate-limit/PII 由来の拒否は
 *   200 開始後の `error` フレームで返す。本クライアントは両者を `{type:"error", status, reason, message?}`
 *   に揃えて yield し、UI のエラー処理を 1 本化する (message はサーバ提供時のみ。request-level は
 *   reason=サーバの error コードで、文言マップは UI 側 = 多言語スライスの責務)。
 * - **純粋・DOM 非依存**: React/DOM に依存せず `fetch` だけを使うので決定的に単体テストできる
 *   (ADR-012)。`fetchImpl` 注入でテストはモック Response を返す。
 *
 * 関連: route.ts (#371) の SSE 契約 (delta `{text}` / error `{status,reason,message}` /
 * done `{sessionId,messageId}`), ADR-006 (SSE)。
 */

/** UI が受け取る型付きチャットイベント。route の SSE フレームと 1:1 対応。 */
export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "error"; status: number; reason: string; message?: string }
  | { type: "done"; sessionId: string; messageId: string };

/** 生徒チャット SSE エンドポイント。トークンは送らず httpOnly cookie `__student_session` で認証する。 */
export const STUDENT_CHAT_ENDPOINT = "/api/student/chat";
/** 教員チャット SSE エンドポイント (#370)。Identity Platform セッションで認証する。 */
export const TEACHER_CHAT_ENDPOINT = "/api/teacher/chat";

/** {@link streamChat} の入力。 */
export interface StreamChatParams {
  /** 生徒/教員の質問文 (生 PII を含みうる。マスキングはサーバ側 chat-service の責務)。 */
  question: string;
  /**
   * 投稿先 SSE エンドポイント。既定は生徒経路 ({@link STUDENT_CHAT_ENDPOINT})。教員 UI は
   * {@link TEACHER_CHAT_ENDPOINT} を渡す (#370)。いずれも認証は cookie / session で行い、本体は質問のみ。
   */
  endpoint?: string;
  /** 中断用シグナル (ページ離脱・キャンセル時に fetch を abort)。 */
  signal?: AbortSignal;
  /** テスト用の fetch 差し替え (既定はグローバル `fetch`)。 */
  fetchImpl?: typeof fetch;
}

/** SSE フレーム区切り (route は `\n\n` 区切りで送出)。 */
const FRAME_SEPARATOR = "\n\n";

/**
 * 質問を送信し、応答 SSE を {@link ChatEvent} の async generator として返す。
 *
 * 正常系は `delta`* → `done` を yield。拒否は `error` を 1 件 yield して終了する。
 * フレーム途中で受信が分割されても (TCP/チャンク境界) バッファリングで正しく再構成する。
 */
export async function* streamChat(params: StreamChatParams): AsyncGenerator<ChatEvent> {
  const { question, signal } = params;
  const endpoint = params.endpoint ?? STUDENT_CHAT_ENDPOINT;
  const doFetch = params.fetchImpl ?? fetch;

  const res = await doFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    // 認証 cookie (__student_session) + 端末識別子 cookie (kt_qa_cid、レート制限第二キー) の
    // 送受信に必須。トークンは cookie 経由で送られ URL/JS には出さない (F05 秘匿維持)。
    credentials: "same-origin",
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  // 200 + event-stream 以外は request-level 拒否 (410 gone / 400 invalid_body|invalid_json)。
  if (!res.ok || !contentType.includes("text/event-stream")) {
    let reason = "request_failed";
    try {
      const body = (await res.json()) as { error?: unknown } | null;
      if (body && typeof body.error === "string") reason = body.error;
    } catch {
      // 非 JSON / 空ボディはそのまま request_failed として扱う。
    }
    yield { type: "error", status: res.status, reason };
    return;
  }

  if (!res.body) {
    yield { type: "error", status: res.status, reason: "no_body" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf(FRAME_SEPARATOR);
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + FRAME_SEPARATOR.length);
        const ev = parseFrame(frame);
        if (ev) yield ev;
        sep = buffer.indexOf(FRAME_SEPARATOR);
      }
    }
    // 末尾フレームが `\n\n` で終端せず終わった場合に備えて残バッファを flush。
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 1 つの SSE フレーム文字列 (`event: X\ndata: Y` 群) を {@link ChatEvent} に解析する。
 * 空フレーム・未知イベント・不正 JSON は `null` を返し UI を落とさない。
 */
function parseFrame(frame: string): ChatEvent | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;

  let eventName = "message";
  const dataParts: string[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) continue; // コメント行 (heartbeat 等)。
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? "" : line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1); // SSE 仕様: 値先頭の 1 スペースを除去。
    if (field === "event") eventName = val;
    else if (field === "data") dataParts.push(val);
  }
  if (dataParts.length === 0) return null;

  let data: unknown;
  try {
    data = JSON.parse(dataParts.join("\n"));
  } catch {
    return null; // 壊れたフレームは無視。
  }
  return toChatEvent(eventName, data);
}

/** イベント名 + data から {@link ChatEvent} を構築。型が合わなければ `null`。 */
function toChatEvent(eventName: string, data: unknown): ChatEvent | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (eventName) {
    case "delta":
      return typeof d.text === "string" ? { type: "delta", text: d.text } : null;
    case "error":
      return {
        type: "error",
        status: typeof d.status === "number" ? d.status : 500,
        reason: typeof d.reason === "string" ? d.reason : "error",
        message: typeof d.message === "string" ? d.message : undefined,
      };
    case "done":
      return typeof d.sessionId === "string" && typeof d.messageId === "string"
        ? { type: "done", sessionId: d.sessionId, messageId: d.messageId }
        : null;
    default:
      return null; // 未知イベント (将来拡張) は無視。
  }
}
