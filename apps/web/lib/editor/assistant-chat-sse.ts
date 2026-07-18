import { isAiEnabled } from "@/lib/ai/ai-enabled";
import { resolveEditorModelConfig } from "@/lib/ai/editor-model-config";
import { getDb } from "@/lib/db";
import {
  type RateLimiter,
  type VertexAssistantChatClient,
  createVertexAssistantChatClient,
  findSuspectedPersonalNames,
  findUnmaskedPii,
  maskPII,
  unmaskDeep,
  unmaskPII,
} from "@kimiterrace/ai";
import { type TenantContext, auditLog, withTenantContext } from "@kimiterrace/db";
import { jstDateLabel, jstUpcomingDateTable } from "./assistant-core";
import {
  ASSISTANT_CHAT_EVENTS,
  type AssistantChatErrorReason,
  type AssistantDraft,
  type DraftSectionKind,
  EMPTY_DRAFT,
  draftHasItems,
  draftItemCounts,
  filterDraftToSections,
  parseChatTurns,
  sanitizeDraft,
} from "./assistant-chat-core";
import { buildAssistantChatSystem, buildAssistantChatUser } from "./assistant-chat-prompt";
import { editorAiRateLimiter } from "./editor-ai-rate-limiter";
import type { EditorActor, EditorTarget } from "./schedule-core";

/**
 * 会話型 AI アシスタント（finding 2b）の **SSE ストリーミング配線コア**。
 *
 * 既存の連絡ドラフト SSE（`notice-draft-sse.ts`）は単発・連絡のみだが、本コアは **多ターン会話**で
 * 1 ターンに「会話応答(reply) + 構造化下書き(予定/連絡/提出物)」を同時にストリーミングする
 * （`packages/ai` の `createVertexAssistantChatClient`・object mode `partialObjectStream`）。route から
 * 認証・target/actor/context・許可セクション解決を抜いた共通実装で、メモではなく **会話履歴 + 現在の下書き**を
 * 受け取り、1 ターン分の応答を SSE で返すまでを担う（API 契約は assistant-chat-core / 契約 doc）。
 *
 * ## 設計（CLAUDE.md ルール1/2/4/5・ADR-030・notice-draft-sse 踏襲）
 * - **拒否の返し方**: AI 無効(503)・不正ボディ(400) は **200 SSE を開く前**に実 HTTP(JSON)。soft-gate
 *   (pii_warning)/rate-limit/pii_leak/生成失敗は **200 開始後の SSE `error` フレーム**（UI は入力・カードを失わない）。
 * - **PII（ルール4）= 単一マスク往復**: 会話履歴 + 現在の下書きを 1 つの user プロンプトへ平坦化し
 *   （assistant-chat-prompt）、**1 回だけ** `maskPII`（電話/メール）+ `findUnmaskedPii` fail-closed。
 *   モデル応答（reply + 下書き）を**同じ辞書**で逆マスクし、逆マスク後も fail-closed で再検査（漏れたら中止）。
 *   氏名らしき高確信パターン（ADR-030 soft-gate）は **Vertex に送る平坦化プロンプト全体**（会話履歴 + 下書き）に
 *   対して検査し（gate を素通りする経路を作らない）、未 override は送信せず警告。
 * - **パターン準拠（finding①）**: `allowedSections` 外のセクションは system で禁止 + 出力を
 *   `filterDraftToSections` で落とす二段。来校者/呼び出しは下書き型に無い（ADR-034・型で除外）。
 * - **RLS/監査（ルール1/2）**: 生成は DB 非依存。成功ターンの最後に LLM 呼び出しを `audit_log` に記録する短い
 *   `withTenantContext` tx を 1 回（本文/生 PII は残さず件数のみ）。actor/context は route がセッションから導出。
 * - **AI kill-switch（#289/ルール4）**: `AI_ENABLED !== "true"` なら実 Vertex を呼ぶ前に 503。
 */

/**
 * モデル応答の**ストール上限（ms）**。partial が一定時間来ない（初回トークンが来ない / 途中で止まる）と
 * Vertex 呼び出しを能動的に中断し `stream_failed` に畳む。Cloud Run の既定リクエストタイムアウト(300s)で
 * 接続だけ切られて `meta` だけ送った状態で固まる事故（#982 本番「考えています」ハング）を防ぐため、十分手前で切る。
 */
const STREAM_STALL_MS = 60_000;

/** 名前付き SSE フレーム（`event: <name>\ndata: <json>\n\n`）。 */
function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * マスク空間の reply 全文 `masked` の、オフセット `from` 以降で **マスクトークン {{...}} を途中で分割しない**
 * 安全な emit 終端を返す。partial 境界でトークンが割れると逆マスクのオフセットがずれて表示が壊れるため、
 * 末尾に未終端の `{{`（対応する `}}` が無い）があればその手前で止め、トークンが揃う次の partial まで保留する。
 */
function safeEmitEnd(masked: string, from: number): number {
  const lastOpen = masked.lastIndexOf("{{");
  if (lastOpen < from) {
    return masked.length;
  }
  const closeAfter = masked.indexOf("}}", lastOpen);
  return closeAfter === -1 ? lastOpen : masked.length;
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
export interface AssistantChatDeps {
  streamClient: VertexAssistantChatClient;
  rateLimiter: RateLimiter;
  nowMs?: number;
  /** モデル応答のストール上限（ms）。既定 {@link STREAM_STALL_MS}。テストは小さい値で中断挙動を検証する。 */
  streamStallMs?: number;
}

let memoStreamClient: VertexAssistantChatClient | null = null;
/** 実 Vertex stream client を env から遅延生成（construct は lazy = 認証/通信なし、generate 時のみ ADC）。 */
function getStreamClient(): VertexAssistantChatClient {
  if (memoStreamClient) return memoStreamClient;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  // model ID / thinking budget は env で差し替え可能（#593）。温度・出力上限はクライアント既定（忠実寄り）。
  const { modelId, tuning } = resolveEditorModelConfig();
  memoStreamClient = createVertexAssistantChatClient({ project, location, modelId, tuning });
  return memoStreamClient;
}

function defaultDeps(): AssistantChatDeps {
  return { streamClient: getStreamClient(), rateLimiter: editorAiRateLimiter };
}

/** {@link respondWithAssistantChat} の引数。認証・target/actor/context・許可セクション解決は route の責務。 */
export interface AssistantChatArgs {
  /** 解決済み編集対象（自校 RLS で可視・別テナントは route が 404）。 */
  target: EditorTarget;
  /** 監査 actor（userId + schoolId、セッション由来）。 */
  actor: EditorActor;
  /** 監査 tx を張る RLS context（{userId, schoolId, role}、ADR-019）。 */
  tenantContext: TenantContext;
  /** このクラスの実効パターンが盤面に出す（=会話型 AI が下書きできる）セクション（finding①）。読み取り専用。 */
  allowedSections: readonly DraftSectionKind[];
  /** 実効サイネージパターン（meta フレーム表示用・例 "pattern1"）。 */
  pattern: string;
  /**
   * 同パターンで盤面に出るが **AI が作らない**（教員手入力の）セクションのラベル（来校者一覧/生徒呼び出し
   * 等・ADR-034）。system プロンプトの手入力誘導 + meta フレームに使う（pattern1 では空）。読み取り専用。
   */
  manualSectionLabels: readonly string[];
}

/** SSE 開始後の `error` フレームを送って終了する小ヘルパの戻り（呼び出し側で return する）。 */
type SendFn = (event: string, data: unknown) => void;

function sendError(
  send: SendFn,
  status: number,
  reason: AssistantChatErrorReason,
  extra?: { suspectedSurfaces?: string[]; message?: string },
): void {
  send(ASSISTANT_CHAT_EVENTS.error, { status, reason, ...extra });
}

/**
 * 解決済みの会話履歴 + 現在の下書き → 1 ターン分の応答（会話文 + 構造化下書き）を SSE で返す。
 *
 * SSE 契約: `meta {pattern,allowedSections}` → (`message {delta}`)* → (`draft <AssistantDraft>`)* →
 * `done {draft}`。拒否は `error {status,reason,...}`（pii_warning は `suspectedSurfaces`）。
 */
export async function respondWithAssistantChat(
  args: AssistantChatArgs,
  request: Request,
  deps: AssistantChatDeps = defaultDeps(),
): Promise<Response> {
  // 0) kill-switch: AI 無効時は実 Vertex を呼ぶ前に 503（既定 OFF・ルール4 / ADR-030）。
  if (!isAiEnabled()) {
    return jsonError(503, "ai_disabled");
  }

  // 1) ボディ検証。JSON 不正・messages 不正は 200 を開く前に実 HTTP で弾く。draft は防御的に正規化。
  let messages: ReturnType<typeof parseChatTurns>;
  let draft: AssistantDraft;
  let acknowledgePii: boolean;
  try {
    const body: unknown = await request.json();
    const rec = (body ?? {}) as { messages?: unknown; draft?: unknown; acknowledgePii?: unknown };
    messages = parseChatTurns(rec.messages);
    draft = sanitizeDraft(rec.draft);
    acknowledgePii = rec.acknowledgePii === true;
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (!messages) {
    return jsonError(400, "invalid");
  }
  const turns = messages;

  const now = deps.nowMs ?? Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SendFn = (event, data) =>
        controller.enqueue(encoder.encode(sseFrame(event, data)));
      try {
        // meta: パターン文脈・許可セクション・手入力セクション（来校者/呼び出し等）を最初に通知（UI が把握）。
        send(ASSISTANT_CHAT_EVENTS.meta, {
          pattern: args.pattern,
          allowedSections: args.allowedSections,
          manualSections: args.manualSectionLabels,
        });

        // Vertex 送信サーフェスを **1 回だけ**組み立てる（会話履歴 + 現在の下書きを平坦化）。soft-gate と
        // マスクは「実際に送る文字列そのもの」にかける（gate を素通りする経路を作らない・Reviewer HIGH）。
        const dateLabel = jstDateLabel(now);
        const userPrompt = buildAssistantChatUser(turns, draft, args.allowedSections);

        // ADR-030 soft-gate: **送信サーフェス全体**（user/assistant ターン + 下書き JSON）の氏名らしき高確信
        // パターンを検査。氏名は書式マスク対象外ゆえ本 gate が唯一の名前制御で、assistant ターンや draft 経由の
        // 名前混入も捕捉する（未 override は送信せず警告）。override は per-request（ADR-030/036）。
        const suspects = findSuspectedPersonalNames(userPrompt);
        if (suspects.length > 0 && !acknowledgePii) {
          sendError(send, 409, "pii_warning", {
            suspectedSurfaces: Array.from(new Set(suspects.map((s) => s.surface))),
          });
          return;
        }

        // per-school レート制限（マスク/モデル呼び出しより前に弾く）。
        if (!(await deps.rateLimiter.tryAcquire(args.actor.schoolId, now))) {
          sendError(send, 429, "rate_limited");
          return;
        }

        // 単一マスク往復: 上の userPrompt に 1 回だけ電話/メールをマスク。fail-closed: 残存（辞書化漏れ）なら
        // 送らず中止（ルール4）。
        const system = buildAssistantChatSystem(
          args.allowedSections,
          dateLabel,
          args.manualSectionLabels,
          // 実在日付↔曜日の対応表（曜日算術ミス・相対日付の解決ミスの根治。deps.nowMs 基準で決定的）。
          jstUpcomingDateTable(now),
        );
        const { masked, dictionary } = maskPII(userPrompt, []);
        if (findUnmaskedPii(masked, []).length > 0) {
          sendError(send, 422, "pii_leak");
          return;
        }

        // 漸進ストリーム: reply の伸長を message delta に、下書きスナップショットを draft フレームに写像。
        // emittedReplyLen は **マスク空間（partial.reply）** のオフセット（逆マスクで長さが変わっても安定）。
        let emittedReplyLen = 0;
        let lastDraft: AssistantDraft = { ...EMPTY_DRAFT };
        let lastDraftJson = JSON.stringify(EMPTY_DRAFT);
        // 無応答/ストール対策（#982 本番ハング修正）: 進捗（partial）が一定時間途絶えたら Vertex を中断して
        // stream_failed に畳む。初回トークン待ちと途中ストールの両方を、partial 毎にタイマを張り直して監視する。
        const stallMs = deps.streamStallMs ?? STREAM_STALL_MS;
        const stallController = new AbortController();
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const armStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => stallController.abort(), stallMs);
        };
        try {
          armStall();
          const result = deps.streamClient.stream({
            system,
            user: masked,
            signal: stallController.signal,
          });
          for await (const partial of result.partialStream) {
            armStall(); // 進捗があるたびストール時計をリセット。
            // 会話応答（partial.reply は「ここまでのマスク済み全文」）。マスク空間で delta を切り、**マスク
            // トークンを分割しない安全境界**まで emit して同じ辞書で逆マスク（境界跨ぎで表示が壊れるのを防ぐ）。
            if (typeof partial.reply === "string") {
              const end = safeEmitEnd(partial.reply, emittedReplyLen);
              if (end > emittedReplyLen) {
                const maskedSlice = partial.reply.slice(emittedReplyLen, end);
                // 逆マスク**前**（マスク空間）で leak 検査する。辞書由来の正規 PII は token 化済みでここでは PII
                // 形に見えないため、検出されるのは「モデルが生成した辞書に無い生 PII」(= 真のリーク) のみ。逆マスク
                // 後に検査すると辞書由来の復元値（教員が連絡に書いた電話/メール等）まで誤検知し、正しい入力なのに
                // 毎ターン pii_leak でターンが中断する（ルール4・マスクが取りこぼした生 PII の echo も masked 側に
                // 生のまま現れるので本検査で同様に捕捉でき、検出力は落ちない）。
                if (findUnmaskedPii(maskedSlice, []).length > 0) {
                  sendError(send, 422, "pii_leak");
                  return;
                }
                const delta = unmaskPII(maskedSlice, dictionary);
                send(ASSISTANT_CHAT_EVENTS.message, { delta });
                emittedReplyLen = end;
              }
            }

            // 構造化下書き: 検証（sanitize）→ 許可セクション絞り → マスク空間で fail-closed → 逆マスク → 変化時のみ emit。
            const sanitized = filterDraftToSections(sanitizeDraft(partial), args.allowedSections);
            // reply と同理由でマスク空間（逆マスク前）で leak 検査する（辞書由来の正規復元値を誤検知しない・ルール4）。
            if (findUnmaskedPii(JSON.stringify(sanitized), []).length > 0) {
              sendError(send, 422, "pii_leak");
              return;
            }
            const unmaskedDraft = unmaskDeep(sanitized, dictionary);
            const draftJson = JSON.stringify(unmaskedDraft);
            if (draftJson !== lastDraftJson) {
              lastDraft = unmaskedDraft;
              lastDraftJson = draftJson;
              send(ASSISTANT_CHAT_EVENTS.draft, unmaskedDraft);
            }
          }
          // usage の解決を駆動（監査は件数のみだが done を待ち切る・モデル障害をここで捕捉）。
          await result.done;
        } catch {
          // モデル/通信障害・ストール中断（stallController.abort）。本文は出さない。送出済みの reply/draft は
          // UI 側で保持される。クライアントは stream_failed を再試行可能として扱う。
          sendError(send, 500, "stream_failed", { message: "応答の生成に失敗しました。" });
          return;
        } finally {
          // 正常完了・早期 return（pii_leak 等）・中断のいずれでもストールタイマを必ず解除（遅延 abort を残さない）。
          if (stallTimer) clearTimeout(stallTimer);
        }

        // reply も下書きも空＝モデルが何も生成しなかった（no_result）。監査もしない。
        if (emittedReplyLen === 0 && !draftHasItems(lastDraft)) {
          sendError(send, 422, "no_result");
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
              aiAssist: "assistant_chat",
              turns: turns.length,
              ...draftItemCounts(lastDraft),
              suspectedNameCount: suspects.length,
              scope: args.target.scope,
              pattern: args.pattern,
            },
            rowHash: "",
            createdBy: args.actor.userId,
            updatedBy: args.actor.userId,
          });
        });

        send(ASSISTANT_CHAT_EVENTS.done, { draft: lastDraft });
      } catch {
        sendError(send, 500, "stream_failed", { message: "内部エラーが発生しました。" });
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
