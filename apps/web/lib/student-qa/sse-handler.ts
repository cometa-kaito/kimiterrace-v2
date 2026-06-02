import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { executeChat } from "@/lib/student-qa/chat-service";
import { createRagContentProvider } from "@/lib/student-qa/context-provider";
import {
  createVertexChatStreamClient,
  createVertexEmbeddingClient,
  normalizeLocale,
} from "@kimiterrace/ai";
import { type ResolvedMagicLink, withTenantContext } from "@kimiterrace/db";

/**
 * F06 (#42, #371): 生徒対話 Q&A の **SSE 配線コア** (route から認証経路を抜いた共通実装)。
 *
 * 「**解決済みの magic link** ({@link ResolvedMagicLink}) を受け取り、質問 1 件を SSE で返す」までを
 * 担う。**トークンの解決方法 (URL path か httpOnly cookie か) は route に委ねる**ことで、認証経路ごとに
 * route を薄く保ち、SSE/HTTP 配線をここで単一ソース化する。現状の本番経路は cookie 経由
 * (`/api/student/chat` → {@link resolveStudentSession})。
 *
 * ## 設計 (CLAUDE.md ルール2/4/5、元 route #373/#482 の設計を継承)
 * - **credential を URL/ログに載せない (ルール5)**: magic link トークンは F05 で httpOnly cookie
 *   (`__student_session`) に移し、URL path に出さない。本コアは **既に解決済みの id/schoolId/classId**
 *   だけを受け取り、生トークンには一切触れない (Cloud Run のアクセスログにトークンが残らない)。
 * - **RLS tx 寿命 = ストリーム寿命 (ルール2)**: 永続化 (user→assistant) を呼び出し側が張る RLS tx 内で
 *   行うため、`withTenantContext` を `ReadableStream` の `start()` 内で回し、チャンク送出 + `await done`
 *   までを 1 つの tx で囲う (tx がストリーム途中で閉じない、[[sse-over-rls-tx-pattern]])。handler は
 *   即 `Response(stream)` を返す。
 * - **拒否の返し方**: 不正ボディ (400) は **200 SSE を開く前**に実 HTTP で返す。validate/rate-limit/PII
 *   由来の拒否は `executeChat` が内部で 1 回だけ判定する (route で先行実行すると rate-limit を二重消費する)
 *   ため、200 開始後の **SSE `error` フレーム**で通知する。無効トークン (410) は route の責務。
 * - **PII (ルール4)**: 生徒は匿名で氏名ロスターが無いため `piiEntries` は空。質問内の電話/メールは
 *   `maskPII` の検出 (既定 ON) が chat-service 内で除去する。grounding コンテンツも chat-service が
 *   マスクしてから Vertex/DB へ渡す。本コアは生 PII を組み立てない。
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
 * 解決済み magic link 1 件分の質問を処理し、SSE (`text/event-stream`) Response を返す。
 *
 * @param resolved トークン解決済みの {@link ResolvedMagicLink} (route が URL/cookie から確立)
 * @param request  元の `Request` (ボディ・cookie・Accept-Language を読む)
 */
export async function respondWithChatStream(
  resolved: ResolvedMagicLink,
  request: Request,
): Promise<Response> {
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

  // 2) 端末識別子 cookie (レート制限の第二キー)。無ければ採番して Set-Cookie する。
  let cookieId = readCookie(request.headers.get("cookie"), QA_COOKIE);
  let issueCookie = false;
  if (!cookieId) {
    cookieId = randomUUID();
    issueCookie = true;
  }

  // 2.5) 拒否文言ロケール (ADR-028 §2)。匿名生徒は profile が無いので Accept-Language の第一言語を
  //      best-effort で採用 (未対応は ja フォールバック)。in_scope 回答の言語は Gemini が質問に追従する。
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
        await withTenantContext(getDb(), { schoolId: resolved.schoolId }, async (tx) => {
          const result = await executeChat({
            tx,
            schoolId: resolved.schoolId,
            classId: resolved.classId,
            magicLinkId: resolved.id,
            // cookieId は手順 2 で必ず確定済 (null 不可)。
            cookieId: cookieId as string,
            rawQuestion: question,
            // 匿名生徒・氏名ロスター無し。質問の電話/メールは chat-service の maskPII が除去 (ルール4)。
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
  if (issueCookie) {
    headers.append(
      "set-cookie",
      `${QA_COOKIE}=${cookieId}; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${QA_COOKIE_MAX_AGE}`,
    );
  }
  return new Response(stream, { status: 200, headers });
}
