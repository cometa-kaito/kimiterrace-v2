import { isAiEnabled } from "@/lib/ai/ai-enabled";
import { getDb } from "@/lib/db";
import {
  type RateLimiter,
  type VertexNoticeStreamClient,
  createPerSchoolRateLimiter,
  createVertexNoticeStreamClient,
  findSuspectedPersonalNames,
  findUnmaskedPii,
  maskPII,
  unmaskPII,
} from "@kimiterrace/ai";
import { type TenantContext, auditLog, withTenantContext } from "@kimiterrace/db";
import {
  ASSIST_INPUT_MAX,
  NOTICE_ASSIST_STREAM_SYSTEM,
  NOTICE_TONE_INSTRUCTIONS,
  type NoticeTone,
  buildNoticeAssistUser,
  jstDateLabel,
  parseNoticeTone,
} from "./assistant-core";
import type { EditorActor, EditorTarget } from "./schedule-core";

/**
 * 段C+（#243 ②UI-UX, ADR-033）: エディタ AI 連絡ドラフトの **SSE ストリーミング配線コア**。
 *
 * 既存 Server Action（assistant-actions.ts `assistDraftNoticesAction`）は「作成中…」スピナー → 結果一覧
 * という一括 req/response だが、本コアは Notion/Docs 流の「項目ごとに確定ストリーミング → 採用/削除」UX
 * のために、連絡を **1 件ずつ SSE で送出** する（packages/ai `createVertexNoticeStreamClient` の
 * `elementStream`）。route から認証・target/actor 解決を抜いた共通実装で、解決済みの {@link EditorTarget} /
 * {@link EditorActor} / RLS context を受け取り、メモ 1 件分のドラフトを SSE で返すまでを担う。
 *
 * ## 設計（CLAUDE.md ルール1/2/4/5, ADR-030, [[feedback_sse_over_rls_tx_pattern]] を踏襲）
 * - **拒否の返し方**: AI 無効（503）・不正ボディ（400）は **200 SSE を開く前**に実 HTTP（JSON）で返す。
 *   soft-gate（pii_warning）/ rate-limit / pii_leak / 生成失敗は **200 開始後の SSE `error` フレーム**で返す
 *   （UI は既にストリームを開いているのでインライン表示し、入力・完成項目を失わせない＝アンチパターン回避）。
 * - **PII（ルール4）**: Vertex 送信前に書式 PII（電話/メール）を `maskPII` + `findUnmaskedPii` fail-closed。
 *   氏名らしき高確信パターン（ADR-030 soft-gate）は未 override なら送信せず警告。逆マスク後の各要素も
 *   `findUnmaskedPii` で **要素単位 fail-closed**（漏れた項目だけ `notice_redacted` で落とし、他は流す）。
 * - **RLS / 監査（ルール1/2）**: 生成自体は DB 非依存。最後に LLM 呼び出しを `audit_log` に記録する短い
 *   `withTenantContext` tx を 1 回だけ開く（本文/生 PII は残さず件数のみ）。actor/context は route がセッション
 *   から導出（外部入力を信用しない、confused-deputy 防止）。生メモ/応答本文は SSE 以外に出さない。
 * - **AI kill-switch（#289, ルール4 / ADR-030）**: `AI_ENABLED !== "true"` なら実 Vertex を呼ぶ前に 503。
 *
 * **本MVP は連絡のみ**（時間割/提出物の AI 化は後続）。トーン調整 / 部分修正 / ファイル経路は後続スライス。
 */

/** SSE 1 件分のドラフト要素フレーム data（client が採用カードに写像）。 */
export interface NoticeDraftFrame {
  index: number;
  text: string;
  isHighlight: boolean;
}

/** 名前付き SSE フレーム（`event: <name>\ndata: <json>\n\n`）を組み立てる。 */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** request-level の拒否を JSON で返す（200 SSE を開く前の 503/400 用）。 */
function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** 監査の record_id（対象の最も具体的な id。school scope は schoolId）。assistant-actions と同方針。 */
function auditRecordId(target: EditorTarget, actor: EditorActor): string {
  switch (target.scope) {
    case "class":
      return target.classId;
    case "grade":
      return target.gradeId;
    case "department":
      return target.departmentId;
    default:
      return actor.schoolId;
  }
}

/** テスト差し替え用の依存（既定は実 stream client + プロセス内 rate limiter）。 */
export interface NoticeDraftDeps {
  streamClient: VertexNoticeStreamClient;
  rateLimiter: RateLimiter;
  nowMs?: number;
}

const sharedRateLimiter: RateLimiter = createPerSchoolRateLimiter();

let memoStreamClient: VertexNoticeStreamClient | null = null;
/** 実 Vertex stream client を env から遅延生成（construct は lazy = 認証/通信なし、generate 時のみ ADC）。 */
function getStreamClient(): VertexNoticeStreamClient {
  if (memoStreamClient) return memoStreamClient;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoStreamClient = createVertexNoticeStreamClient({ project, location });
  return memoStreamClient;
}

function defaultDeps(): NoticeDraftDeps {
  return { streamClient: getStreamClient(), rateLimiter: sharedRateLimiter };
}

/** {@link respondWithNoticeDraftStream} の引数。認証・target/actor/context 解決は route の責務。 */
export interface NoticeDraftStreamArgs {
  /** 解決済み編集対象（自校 RLS で可視・別テナントは route が 404 にしておく）。 */
  target: EditorTarget;
  /** 監査 actor（userId + schoolId、セッション由来）。 */
  actor: EditorActor;
  /** 監査 tx を張る RLS context（{userId, schoolId, role}、ADR-019）。 */
  tenantContext: TenantContext;
}

/**
 * 解決済み 1 件分のメモ → 連絡ドラフトを SSE（`text/event-stream`）で返す。
 *
 * SSE 契約: `notice {index,text,isHighlight}`* → `done {count}` を送出。要素単位で PII 漏れを検出した項目は
 * `notice_redacted {index}`。拒否は `error {status,reason,message?}`（pii_warning は `suspectedSurfaces` を含む）。
 */
export async function respondWithNoticeDraftStream(
  args: NoticeDraftStreamArgs,
  request: Request,
  deps: NoticeDraftDeps = defaultDeps(),
): Promise<Response> {
  // 0) #289 kill-switch: AI 無効時は実 Vertex を呼ぶ前に 503 で塞ぐ（既定 OFF, ルール4 / ADR-030）。
  if (!isAiEnabled()) {
    return jsonError(503, "ai_disabled");
  }

  // 1) ボディ検証。JSON 不正・空・過大は 200 を開く前に実 HTTP で弾く。tone は再生成時の調整（任意・
  //    未知キーは無視＝外部入力を信用しない）。tone 指示はサーバ定義の固定文ゆえ新たな PII 面を作らない。
  let text: string;
  let acknowledgePii: boolean;
  let tone: NoticeTone | null;
  try {
    const body: unknown = await request.json();
    const rec = (body ?? {}) as { text?: unknown; acknowledgePii?: unknown; tone?: unknown };
    text = typeof rec.text === "string" ? rec.text.trim() : "";
    acknowledgePii = rec.acknowledgePii === true;
    tone = parseNoticeTone(rec.tone);
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (text.length === 0) {
    return jsonError(400, "empty");
  }
  if (text.length > ASSIST_INPUT_MAX) {
    return jsonError(400, "too_long");
  }

  const now = deps.nowMs ?? Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      try {
        // ADR-030 soft-gate: 氏名らしき高確信パターン → 未 override は送信せず警告（surfaces を返す）。
        const suspects = findSuspectedPersonalNames(text);
        if (suspects.length > 0 && !acknowledgePii) {
          send("error", {
            status: 409,
            reason: "pii_warning",
            suspectedSurfaces: Array.from(new Set(suspects.map((s) => s.surface))),
          });
          return;
        }

        // per-school レート制限（マスク/モデル呼び出しより前に弾く）。
        if (!(await deps.rateLimiter.tryAcquire(args.actor.schoolId, now))) {
          send("error", { status: 429, reason: "rate_limited" });
          return;
        }

        // 書式 PII（電話/メール）をマスク。fail-closed: マスク後に残存なら送らず中止（ルール4）。
        const { masked, dictionary } = maskPII(text, []);
        if (findUnmaskedPii(masked, []).length > 0) {
          send("error", { status: 422, reason: "pii_leak" });
          return;
        }

        // 連絡を 1 件ずつ確定ストリーミング。要素ごとに逆マスク + fail-closed。
        let count = 0;
        let index = 0;
        try {
          const result = deps.streamClient.stream({
            system: NOTICE_ASSIST_STREAM_SYSTEM,
            user: buildNoticeAssistUser(
              masked,
              jstDateLabel(now),
              tone ? NOTICE_TONE_INSTRUCTIONS[tone] : undefined,
            ),
          });
          for await (const el of result.elementStream) {
            const unmasked = unmaskPII(el.text, dictionary);
            // 逆マスク後の各要素にも PII 残存が無いか fail-closed（漏れた項目だけ落とす、ルール4）。
            if (typeof unmasked !== "string" || unmasked.trim().length === 0) {
              send("notice_redacted", { index });
              index += 1;
              continue;
            }
            if (findUnmaskedPii(unmasked, []).length > 0) {
              send("notice_redacted", { index });
              index += 1;
              continue;
            }
            const frame: NoticeDraftFrame = {
              index,
              text: unmasked,
              isHighlight: el.isHighlight === true,
            };
            send("notice", frame);
            index += 1;
            count += 1;
          }
          // usage の解決を駆動（監査の token 数等。本MVPは件数監査のみだが done を待ち切る）。
          await result.done;
        } catch {
          // モデル/通信障害。本文は出さない。既に送出済みの項目は UI 側で保持される。
          send("error", {
            status: 500,
            reason: "stream_failed",
            message: "応答の生成に失敗しました。",
          });
          return;
        }

        if (count === 0) {
          send("error", { status: 422, reason: "no_result" });
          return;
        }

        // ルール1/4: LLM 呼び出しを audit_log に記録（本文は残さず件数のみ）。短い RLS tx を 1 回だけ。
        await withTenantContext(getDb(), args.tenantContext, async (tx) => {
          await tx.insert(auditLog).values({
            actorUserId: args.actor.userId,
            schoolId: args.actor.schoolId,
            tableName: "daily_data",
            recordId: auditRecordId(args.target, args.actor),
            operation: "update",
            diff: {
              aiAssist: "notices_draft_stream",
              noticeCount: count,
              suspectedNameCount: suspects.length,
              scope: args.target.scope,
            },
            rowHash: "",
            createdBy: args.actor.userId,
            updatedBy: args.actor.userId,
          });
        });

        send("done", { count });
      } catch {
        send("error", { status: 500, reason: "internal", message: "内部エラーが発生しました。" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: new Headers({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    }),
  });
}
