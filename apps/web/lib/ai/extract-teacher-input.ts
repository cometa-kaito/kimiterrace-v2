import {
  type ExtractionKind,
  type ModelClient,
  type PiiEntry,
  PiiLeakError,
  type RateLimiter,
  RateLimitExceededError,
  type StructureResult,
  type SuggestedPeriod,
  type SuggestedPublishScope,
  createPerSchoolRateLimiter,
  createVertexModelClient,
} from "@kimiterrace/ai";
import { getTeacherInput, listStaffDisplayNames } from "@kimiterrace/db";
import { createLogger } from "@kimiterrace/observability";
import { ForbiddenError, UnauthenticatedError, withUserSession } from "../db";
import {
  type RunAndPersistParams,
  getAuthorizedExtractionUser,
  runAndPersistExtraction,
} from "./run-extraction";

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
 * `PiiLeakError` で中止する。
 *
 * **#289 で本トリガは当該 school の職員氏名 roster（{@link listStaffDisplayNames}、教員 / 学校管理者の
 * `display_name`）を `piiEntries`（category=STAFF）として供給する**ようになった。これで自由記述に紛れた
 * 職員氏名は確定トークン化され、fail-closed ガードの監視対象にも入る。
 *
 * ただし **生徒 / 保護者氏名は依然 roster 不在**（本システムは生徒匿名設計）でマスクできない残存リスクが
 * ある。対象 kind は schedule / announcement / summary / tag の **行事・連絡文**で、フィードバック同様
 * 「生徒氏名は記入不要」の運用ガイドが効く前提。生徒/保護者氏名の扱い（記入抑止 UI / NER / kind 制約の
 * いずれか）の確定と、それを満たすまで実 Vertex 呼び出し（#154 item 3）を有効化しないゲート化は #289 の
 * 後続項目。生 transcript / 応答本文はログに出さない。
 */

/** 抽出トリガの結果（route が HTTP に写像する判別共用体）。 */
export type ExtractTeacherInputResult =
  | {
      ok: true;
      status: "success" | "failed";
      confidenceScore: number | null;
      // F01 (2026-06-03): 教員 UI の既定値 pre-fill 用の提案（任意・成功時のみ非 null になりうる）。
      // 下書き作成 (createDraftFromInputAction) へ橋渡しして公開先・掲示期間の既定に反映する。
      suggestedPublishScope?: SuggestedPublishScope;
      suggestedPeriod?: SuggestedPeriod;
    }
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
  /**
   * 当該 school の職員氏名を Vertex 送信前マスキング用 `PiiEntry[]`（category=STAFF）として読む。
   * RLS context で職員氏名 roster を引き、確定トークン化に渡す（ルール4 / #289）。未認証は throw。
   */
  loadStaffPiiEntries: () => Promise<PiiEntry[]>;
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
  // gate-first: transcript 読取の前に role を弾く (非作者に他教員の transcript を読ませない、ルール2)。
  const user = await getAuthorizedExtractionUser();
  return withUserSession(user, async (tx) => {
    const row = await getTeacherInput(tx, inputId);
    return row ? { transcript: row.transcript } : null;
  });
}

async function defaultLoadStaffPiiEntries(): Promise<PiiEntry[]> {
  // gate-first: 職員氏名 roster (PII) 読取の前に role を弾く (ルール2 / ルール4)。
  const user = await getAuthorizedExtractionUser();
  const names = await withUserSession(user, (tx) => listStaffDisplayNames(tx));
  return names.map((value) => ({ value, category: "STAFF" as const }));
}

function defaultDeps(): ExtractTeacherInputDeps {
  return {
    loadTranscript: defaultLoadTranscript,
    loadStaffPiiEntries: defaultLoadStaffPiiEntries,
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

    // 職員氏名 roster をマスキング供給 (#289)。transcript 確定後に引く (no_transcript 時は無駄引きしない)。
    const piiEntries = await deps.loadStaffPiiEntries();

    const result = await deps.runAndPersist({
      request: {
        kind,
        input: transcript,
        model: deps.model,
        rateLimiter: deps.rateLimiter,
        // 職員氏名は確定トークン化。書式 PII (電話/メール) は structureContent が常時マスク。
        // 生徒/保護者氏名は匿名設計で roster 不在 → 上記 docstring の残存リスク (後続項目)。
        piiEntries,
        ...(deps.nowMs === undefined ? {} : { nowMs: deps.nowMs }),
      },
      contentId: null,
    });

    return {
      ok: true,
      status: result.status,
      confidenceScore: result.confidenceScore,
      // 提案は任意。抽出成功時のみ extraction に載りうる（失敗時は extraction=null）。
      suggestedPublishScope: result.extraction?.suggestedPublishScope,
      suggestedPeriod: result.extraction?.suggestedPeriod,
    };
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
