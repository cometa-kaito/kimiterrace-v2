import {
  type ExtractionKind,
  type ModelClient,
  PiiLeakError,
  type RateLimiter,
  RateLimitExceededError,
  type StructureResult,
  createPerSchoolRateLimiter,
  createVertexModelClient,
} from "@kimiterrace/ai";
import { getTeacherInput } from "@kimiterrace/db";
import { createLogger } from "@kimiterrace/observability";
import { getCurrentUser } from "../auth/session";
import { ForbiddenError, UnauthenticatedError, withUserSession } from "../db";
import { type RunAndPersistParams, runAndPersistExtraction } from "./run-extraction";

/**
 * F03 (#154 item 2b + 4): 教員入力 transcript → AI 構造化抽出を起動する **トリガ**。
 *
 * #267 の {@link runAndPersistExtraction} seam（認証 + role ゲート + 抽出 + ai_extractions 監査 INSERT +
 * エラー伝播）の上に、(a) 対象 teacher_input の transcript ロード、(b) 実 Vertex model / per-school
 * rate limiter / kind を束ねた `request` 組み立て、(c) **エラー → UX 結果のマッピング**（429 相当 /
 * PII leak 中止 / 403 / 401 / 404）を載せる。route (`POST /api/teacher-inputs/:id/extract`) から呼ぶ。
 *
 * ## PII マスキング (CLAUDE.md ルール4) の現状と限界 — 重要
 * `structureContent` は送信前に **電話・メールを常時マスク**（書式 PII、`maskPII` の正規表現）し、
 * 送信直前の `findUnmaskedPii` fail-closed ガードで電話・メール・**名簿エントリ**の残存を検出して
 * `PiiLeakError` で中止する。一方、本トリガが渡す `piiEntries` は現状 **空**（本システムは生徒匿名設計で
 * 生徒/保護者氏名のロスターを持たないため）。対象 kind は schedule / announcement / summary / tag の
 * **行事・連絡文**で、フィードバック同様「氏名記入不要」の運用ガイドが効く前提だが、**自由記述に紛れた
 * 氏名は roster 不在のためマスクされない**残存リスクがある。職員氏名 roster + 生徒氏名ソースを
 * `piiEntries` に供給する強化は #154 後続スライス（本 PR の限界として明記）。生 transcript / 応答本文は
 * ログに出さない。
 */

/** 抽出トリガの結果（route が HTTP に写像する判別共用体）。 */
export type ExtractTeacherInputResult =
  | { ok: true; status: "success" | "failed"; confidenceScore: number | null }
  | {
      ok: false;
      reason:
        | "unauthenticated"
        | "forbidden"
        | "no_transcript"
        | "rate_limited"
        | "pii_leak"
        | "error";
    };

/** transcript ロードの最小返り値（対象不在 → null、transcript 未確定 → transcript:null）。 */
type LoadedInput = { transcript: string | null } | null;

/** トリガの依存（テストで差し替え可能。既定は実装を束ねた {@link defaultDeps}）。 */
export interface ExtractTeacherInputDeps {
  /** 対象 teacher_input の transcript を現在セッションの RLS context で読む（未認証は throw）。 */
  loadTranscript: (inputId: string) => Promise<LoadedInput>;
  /** #267 seam。成功/失敗いずれも ai_extractions に監査し、rate/PII leak は throw で伝播。 */
  runAndPersist: (
    params: RunAndPersistParams,
    deps?: Parameters<typeof runAndPersistExtraction>[1],
  ) => Promise<StructureResult>;
  /** 実 Vertex model（テストでは未使用のダミー）。 */
  model: ModelClient;
  /** school 単位レート制限（プロセス内シングルトン）。 */
  rateLimiter: RateLimiter;
  /** PII を出さない構造化ロガー（PiiLeak 等の運用事象を記録）。 */
  logger: Pick<ReturnType<typeof createLogger>, "warn" | "error">;
  /** rate-limit 判定時刻（テスト決定化用、既定は実時刻）。 */
  nowMs?: number;
}

const sharedRateLimiter: RateLimiter = createPerSchoolRateLimiter();
const extractionLogger = createLogger("ai-extraction");

let memoModel: ModelClient | null = null;
/** 実 Vertex model を env から遅延生成（construct は lazy = 認証/通信なし、generate 時のみ ADC）。 */
function getExtractionModel(): ModelClient {
  if (memoModel) return memoModel;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoModel = createVertexModelClient({ project, location });
  return memoModel;
}

async function defaultLoadTranscript(inputId: string): Promise<LoadedInput> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthenticatedError();
  }
  return withUserSession(user, async (tx) => {
    const row = await getTeacherInput(tx, inputId);
    return row ? { transcript: row.transcript } : null;
  });
}

function defaultDeps(): ExtractTeacherInputDeps {
  return {
    loadTranscript: defaultLoadTranscript,
    runAndPersist: runAndPersistExtraction,
    model: getExtractionModel(),
    rateLimiter: sharedRateLimiter,
    logger: extractionLogger,
  };
}

/**
 * 対象 teacher_input を AI 構造化抽出にかけ、結果を UX 結果に写像する。
 *
 * 認証/認可（teacher・school_admin のみ）・schoolId 強制・監査記録は seam が担保。本関数は throw せず、
 * すべてのエラーを {@link ExtractTeacherInputResult} に畳む（route が HTTP に変換）。
 */
export async function extractTeacherInput(
  inputId: string,
  kind: ExtractionKind,
  deps: ExtractTeacherInputDeps = defaultDeps(),
): Promise<ExtractTeacherInputResult> {
  try {
    const loaded = await deps.loadTranscript(inputId);
    const transcript = loaded?.transcript ?? null;
    if (transcript === null || transcript.trim().length === 0) {
      // 他校/不在、または文字起こし未確定 → 抽出対象なし。
      return { ok: false, reason: "no_transcript" };
    }

    const result = await deps.runAndPersist({
      request: {
        kind,
        input: transcript,
        model: deps.model,
        rateLimiter: deps.rateLimiter,
        // piiEntries は空（上記 docstring の限界）。書式 PII は structureContent が常時マスク。
        ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
      },
      contentId: null,
    });

    return { ok: true, status: result.status, confidenceScore: result.confidenceScore };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { ok: false, reason: "unauthenticated" };
    if (err instanceof ForbiddenError) return { ok: false, reason: "forbidden" };
    if (err instanceof RateLimitExceededError) return { ok: false, reason: "rate_limited" };
    if (err instanceof PiiLeakError) {
      // fail-closed 作動 = セキュリティ事象。transcript/PII は出さず inputId のみ記録（ルール4）。
      // pino API は merging object が第1引数、msg が第2引数。
      deps.logger.error({ inputId }, "AI 抽出を中止: PII マスク漏れガードが作動");
      return { ok: false, reason: "pii_leak" };
    }
    // 想定外（DB / model 障害等）。本文は出さない。
    deps.logger.error({ inputId }, "AI 抽出に失敗");
    return { ok: false, reason: "error" };
  }
}
