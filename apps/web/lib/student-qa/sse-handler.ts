import { randomUUID } from "node:crypto";
import { isAiEnabled } from "@/lib/ai/ai-enabled";
import { getDb } from "@/lib/db";
import { type ChatIdentity, executeChat } from "@/lib/student-qa/chat-service";
import { createRagContentProvider } from "@/lib/student-qa/context-provider";
import {
  createVertexChatStreamClient,
  createVertexEmbeddingClient,
  normalizeLocale,
} from "@kimiterrace/ai";
import { type TenantContext, withTenantContext } from "@kimiterrace/db";

/**
 * F06 (#42, #371/#370): 生徒・教員対話 Q&A の **SSE 配線コア** (route から認証経路を抜いた共通実装)。
 *
 * 「**認証・識別子の解決は route に委ね**、解決済みの {@link ChatIdentity} + RLS context を受け取り、質問
 * 1 件を SSE で返す」までを担う。これにより認証経路ごとに route を薄く保ち、SSE/HTTP 配線と
 * `executeChat` 呼び出しをここで単一ソース化する。本番経路:
 * - 生徒 (`/api/student/chat`): httpOnly cookie `__student_session` を再解決 (匿名、school_id context)。
 * - 職員 (`/api/teacher/chat`): Identity Platform セッションを role gate (PUBLISHER_ROLES=school_admin のみ・teacher は finding⑧ で除外, #370)。
 *
 * ## 設計 (CLAUDE.md ルール2/4/5、元 route #373/#482 の設計を継承)
 * - **credential を URL/ログに載せない (ルール5)**: magic link トークンは F05 で httpOnly cookie に移し、
 *   本コアは **解決済みの identity (生徒 magic_link id ⊻ 教員 user_id)** だけを受け取り生トークンに触れない。
 * - **RLS tx 寿命 = ストリーム寿命 (ルール2)**: 永続化 (user→assistant) を呼び出し側が張る RLS tx 内で
 *   行うため、`withTenantContext` を `ReadableStream` の `start()` 内で回し、チャンク送出 + `await done`
 *   までを 1 つの tx で囲う (tx がストリーム途中で閉じない、[[sse-over-rls-tx-pattern]])。handler は
 *   即 `Response(stream)` を返す。tenantContext は route が用意 (生徒=schoolId のみ / 教員=userId+role 込)。
 * - **拒否の返し方**: 不正ボディ (400) は **200 SSE を開く前**に実 HTTP で返す。validate/rate-limit/PII
 *   由来の拒否は `executeChat` が内部で 1 回だけ判定する (route で先行実行すると rate-limit を二重消費する)
 *   ため、200 開始後の **SSE `error` フレーム**で通知する。無効トークン (410) / 未認証 (401/403) は route の責務。
 * - **PII (ルール4)**: 氏名ロスターは渡さない (`piiEntries` 空) ため、質問/コンテキストの電話・メールは
 *   `maskPII` の検出 (既定 ON) が chat-service 内で除去する。本コアは生 PII を組み立てない。
 * - **AI kill-switch (#289, ルール4 / ADR-030)**: AI 無効時 (`AI_ENABLED !== "true"`) は実 Vertex
 *   (Gemini 生成 / embedding) を呼ぶ前に **503 `ai_disabled`** を返す。本コアは生徒 (`/api/student/chat`) と
 *   教員 (`/api/teacher/chat`) の両 chat route が通る単一 choke point なので、ここで塞げば全 chat 入口を
 *   網羅する (route 個別ゲートの追加漏れを防ぐ)。
 *
 * 関連: ADR-005/006 (Vertex/Vercel AI SDK), ADR-016 (magic link), ADR-019 (RLS), ADR-028 (回答ポリシー)。
 */

/** レート制限の第二キー (端末識別子) を載せる cookie 名。HttpOnly = サーバ専用、JS から読めない。 */
const QA_COOKIE = "kt_qa_cid";
/** cookie の有効期間 (秒)。端末識別子なので長め (1 年)。 */
const QA_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Vertex クライアントの env (project / location)。construct は lazy = 認証/通信なし (ルール5)。 */
function vertexEnv(): { project: string; location: string } {
  return {
    project: process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "",
    location: process.env.VERTEX_LOCATION ?? "asia-northeast1",
  };
}

let memoStreamClient: ReturnType<typeof createVertexChatStreamClient> | null = null;
/** Vertex ストリームクライアントを env から遅延生成。 */
function getChatStreamClient(): ReturnType<typeof createVertexChatStreamClient> {
  if (memoStreamClient) return memoStreamClient;
  memoStreamClient = createVertexChatStreamClient(vertexEnv());
  return memoStreamClient;
}

let memoEmbeddingClient: ReturnType<typeof createVertexEmbeddingClient> | null = null;
/** Vertex embedding クライアントを env から遅延生成 (RAG: マスク済み質問→ベクトル、ADR-007)。 */
function getEmbeddingClient(): ReturnType<typeof createVertexEmbeddingClient> {
  if (memoEmbeddingClient) return memoEmbeddingClient;
  memoEmbeddingClient = createVertexEmbeddingClient(vertexEnv());
  return memoEmbeddingClient;
}

/** Cookie ヘッダから 1 つの値を取り出す。無ければ null。 */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 名前付き SSE フレーム (`event: <name>\ndata: <json>\n\n`) を組み立てる。 */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** request-level の拒否を返す共通ヘルパ (route が 410/400 等に使う)。 */
export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * 生徒経路のレート制限第二キー (kt_qa_cid 端末識別子 cookie) を解決する。既存値があればそれを使い、
 * 無ければ採番して Set-Cookie ヘッダ値を返す (HttpOnly/Secure/SameSite=Lax、1 年)。**教員経路は user_id
 * 単一キーのため本 cookie を使わない**。route が呼んで student identity の `cookieId` を組み立てる。
 */
export function resolveStudentQaCookie(request: Request): {
  cookieId: string;
  setCookieHeader: string | null;
} {
  const existing = readCookie(request.headers.get("cookie"), QA_COOKIE);
  if (existing) {
    return { cookieId: existing, setCookieHeader: null };
  }
  const cookieId = randomUUID();
  return {
    cookieId,
    setCookieHeader: `${QA_COOKIE}=${cookieId}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${QA_COOKIE_MAX_AGE}`,
  };
}

/** {@link respondWithChatStream} の引数。トークン解決・認証・cookie 採番は route の責務。 */
export type ChatStreamArgs = {
  /** RLS tx を張る context (生徒=schoolId のみ / 教員=userId+schoolId+role、ADR-019)。 */
  tenantContext: TenantContext;
  /** 永続化/grounding の school_id (string 保証、`tenantContext.schoolId` と一致させる)。 */
  schoolId: string;
  /** 認証アイデンティティ (生徒 magic_link ⊻ 教員 user_id, #370)。 */
  identity: ChatIdentity;
  /** 生徒の kt_qa_cid 新規採番時に付与する Set-Cookie 値 (なければ null)。 */
  setCookieHeader?: string | null;
};

/**
 * 解決済み identity 1 件分の質問を処理し、SSE (`text/event-stream`) Response を返す (生徒・教員共通)。
 *
 * @param args    認証・RLS context・identity (route が確立、上記 {@link ChatStreamArgs})
 * @param request 元の `Request` (ボディ・Accept-Language を読む)
 */
export async function respondWithChatStream(
  args: ChatStreamArgs,
  request: Request,
): Promise<Response> {
  // 0) #289 kill-switch: AI 無効時は実 Vertex (Gemini / embedding) を呼ぶ前に 503 で塞ぐ。
  //    生徒・教員 両 chat route の単一 choke point ＝ここで塞げば全 chat 入口を網羅する
  //    (既定 OFF, ルール4 / ADR-030)。
  if (!isAiEnabled()) {
    return jsonError(503, "ai_disabled");
  }

  // 1) ボディ検証。JSON 不正・question 非文字列は 200 を開く前に 400 で弾く。
  let question: string;
  try {
    const body: unknown = await request.json();
    const q = (body as { question?: unknown } | null)?.question;
    if (typeof q !== "string") {
      return jsonError(400, "invalid_body");
    }
    question = q;
  } catch {
    return jsonError(400, "invalid_json");
  }

  // 2) 拒否文言ロケール (ADR-028 §2)。profile が無い経路では Accept-Language の第一言語を best-effort で
  //    採用 (未対応は ja フォールバック)。in_scope 回答の言語は Gemini が質問に追従する。
  const locale = normalizeLocale(request.headers.get("accept-language")?.split(",")[0]);

  // 3) SSE ストリーム。RLS tx は start() 内で開き、チャンク送出 + done(assistant 永続化) まで保持する。
  const contextProvider = createRagContentProvider({ embeddingClient: getEmbeddingClient() });
  const modelClient = getChatStreamClient();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      try {
        await withTenantContext(getDb(), args.tenantContext, async (tx) => {
          const result = await executeChat({
            tx,
            schoolId: args.schoolId,
            identity: args.identity,
            rawQuestion: question,
            // 氏名ロスター無し。質問の電話/メールは chat-service の maskPII が除去 (ルール4)。
            piiEntries: [],
            contextProvider,
            modelClient,
            locale,
          });

          if (result.kind === "rejected") {
            send("error", {
              status: result.status,
              reason: result.reason,
              message: result.message,
            });
            return;
          }

          for await (const chunk of result.textStream) {
            send("delta", { text: chunk });
          }
          // assistant 永続化はこの tx 内で完了させる。ストリームエラー時の reject を握り潰さない。
          try {
            const fin = await result.done;
            send("done", { sessionId: fin.sessionId, messageId: fin.assistantMessageId });
          } catch {
            send("error", {
              status: 500,
              reason: "stream_failed",
              message: "応答の生成に失敗しました。",
            });
          }
        });
      } catch {
        send("error", { status: 500, reason: "internal", message: "内部エラーが発生しました。" });
      } finally {
        controller.close();
      }
    },
  });

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  if (args.setCookieHeader) {
    headers.append("set-cookie", args.setCookieHeader);
  }
  return new Response(stream, { status: 200, headers });
}
