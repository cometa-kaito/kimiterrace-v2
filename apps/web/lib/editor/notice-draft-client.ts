/**
 * 段C+（#243 ②UI-UX, ADR-033）: エディタ AI 連絡ドラフト UI 用の **SSE クライアント**。
 *
 * `POST /api/editor/notice-draft`（notice-draft-sse.ts）を呼び、サーバが返す**名前付き SSE フレーム**
 * (`event: notice|notice_redacted|done|error`) を解析して型付きイベント {@link NoticeDraftEvent} を逐次
 * yield する。F06 生徒チャットの `chat-client.ts`（`streamChat`）と同じ「POST + ReadableStream 自前解析」
 * 方式を踏襲する（質問がボディなので GET 専用の `EventSource` は使えない）。
 *
 * - **認証は cookie**: `credentials:"same-origin"` で `__session`（教員 Identity Platform セッション）を
 *   自動送信。本体は連絡メモのみで、トークン等は扱わない（ルール5）。PII マスキングはサーバ責務（ルール4）。
 * - **2 種の拒否を 1 経路に正規化**: route は AI 無効(503)・不正ボディ(400)・未認証/権限(401/403)・対象不正
 *   (400) を **SSE を開く前**に非 200 JSON `{error}` で返し、soft-gate(pii_warning)/rate/pii_leak/生成失敗は
 *   200 開始後の `error` フレームで返す。本クライアントは両者を `{type:"error", status, reason, ...}` に揃える。
 * - **純粋・DOM 非依存**: `fetch` だけを使うので決定的に単体テストできる（ADR-012）。`fetchImpl` 注入可。
 *
 * 関連: notice-draft-sse.ts（SSE 契約）, chat-client.ts（先行実装）, ADR-006（SSE）。
 */

import type { NoticeTone } from "./assistant-core";

/** UI が受け取る型付きイベント。route の SSE フレームと 1:1 対応。 */
export type NoticeDraftEvent =
  | { type: "notice"; index: number; text: string; isHighlight: boolean }
  | { type: "notice_redacted"; index: number }
  | { type: "done"; count: number }
  | {
      type: "error";
      status: number;
      reason: string;
      /** soft-gate(pii_warning) 時の検出表層（警告表示用）。 */
      suspectedSurfaces?: string[];
      /** サーバ提供のメッセージ（あれば優先表示）。 */
      message?: string;
    };

/** {@link streamNoticeDraft} の入力。 */
export interface StreamNoticeDraftParams {
  /** 編集対象 scope（class/grade/department/school）。 */
  scope: string;
  /** 編集対象 id（school は null）。クエリに載せる。 */
  targetId: string | null;
  /** 教員のメモ（生 PII を含みうる。マスキングはサーバ責務）。 */
  text: string;
  /** soft-gate 警告を承知して続行する場合 true。 */
  acknowledgePii?: boolean;
  /** 再生成時のトーン/長さ調整（任意。サーバ定義の固定指示に写像される）。 */
  tone?: NoticeTone;
  /** 中断用シグナル（停止ボタン・ページ離脱で fetch を abort）。 */
  signal?: AbortSignal;
  /** テスト用の fetch 差し替え（既定はグローバル `fetch`）。 */
  fetchImpl?: typeof fetch;
}

/** SSE エンドポイント。 */
export const NOTICE_DRAFT_ENDPOINT = "/api/editor/notice-draft";

/** SSE フレーム区切り（route は `\n\n` 区切りで送出）。 */
const FRAME_SEPARATOR = "\n\n";

/**
 * メモを送信し、連絡ドラフトの応答 SSE を {@link NoticeDraftEvent} の async generator として返す。
 *
 * 正常系は `notice`*（`notice_redacted` 混在しうる）→ `done` を yield。拒否は `error` を 1 件 yield して終了。
 * フレーム途中で受信が分割されても（TCP/チャンク境界）バッファリングで正しく再構成する。
 */
export async function* streamNoticeDraft(
  params: StreamNoticeDraftParams,
): AsyncGenerator<NoticeDraftEvent> {
  const doFetch = params.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ scope: params.scope });
  if (params.targetId) {
    qs.set("targetId", params.targetId);
  }

  let res: Response;
  try {
    res = await doFetch(`${NOTICE_DRAFT_ENDPOINT}?${qs.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        acknowledgePii: params.acknowledgePii === true,
        ...(params.tone ? { tone: params.tone } : {}),
      }),
      credentials: "same-origin",
      signal: params.signal,
    });
  } catch {
    // ネットワーク断 / abort。UI 側で「通信に失敗」に写像する。
    yield { type: "error", status: 0, reason: "network" };
    return;
  }

  const contentType = res.headers.get("content-type") ?? "";
  // 200 + event-stream 以外は request-level 拒否（503 ai_disabled / 400 empty 等 / 401/403）。
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
    buffer += decoder.decode();
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** 1 つの SSE フレーム文字列を {@link NoticeDraftEvent} に解析する。空/未知/不正は null。 */
function parseFrame(frame: string): NoticeDraftEvent | null {
  const trimmed = frame.trim();
  if (!trimmed) return null;

  let eventName = "message";
  const dataParts: string[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) continue; // コメント行（heartbeat 等）。
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
  return toEvent(eventName, data);
}

/** イベント名 + data から {@link NoticeDraftEvent} を構築。型が合わなければ null。 */
function toEvent(eventName: string, data: unknown): NoticeDraftEvent | null {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (eventName) {
    case "notice":
      return typeof d.index === "number" && typeof d.text === "string"
        ? { type: "notice", index: d.index, text: d.text, isHighlight: d.isHighlight === true }
        : null;
    case "notice_redacted":
      return typeof d.index === "number" ? { type: "notice_redacted", index: d.index } : null;
    case "done":
      return typeof d.count === "number" ? { type: "done", count: d.count } : null;
    case "error":
      return {
        type: "error",
        status: typeof d.status === "number" ? d.status : 500,
        reason: typeof d.reason === "string" ? d.reason : "error",
        suspectedSurfaces: Array.isArray(d.suspectedSurfaces)
          ? d.suspectedSurfaces.filter((s): s is string => typeof s === "string")
          : undefined,
        message: typeof d.message === "string" ? d.message : undefined,
      };
    default:
      return null; // 未知イベント（将来拡張）は無視。
  }
}
