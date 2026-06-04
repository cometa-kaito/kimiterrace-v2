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
  findSuspectedPersonalNames,
} from "@kimiterrace/ai";
import { auditLog, getTeacherInput, listStaffDisplayNames } from "@kimiterrace/db";
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
 * **生徒 / 保護者氏名は依然 roster 不在**（本システムは生徒匿名設計）で確定マスクできない。これに対し
 * **#289 ③ で ADR-030 の authoring soft-gate を本トリガにも適用**した: 送信前に transcript へ
 * {@link findSuspectedPersonalNames}（敬称連接の高確信ヒューリスティック）を走らせ、検出かつ未 override なら
 * **送信せず** `pii_warning` を返す（hard-block しない soft-gate）。教員が承知の上で override（`acknowledgePii`）
 * した場合のみ、**送信前に件数のみを `audit_log` に記録**（ルール4・NFR04: 誰が PII 含有を承知で送信したかを立証、
 * 監査不能なら送信しない）してから実行する。敬称無しの生氏名は依然残存リスク（Low、運用ガイド + コンテンツ
 * ポリシーで補完、ADR-030）。実 Vertex 呼び出し全体は別途 `AI_ENABLED` kill-switch（#289 ①、route 境界）で
 * gate される。生 transcript / 応答本文はログに出さない。
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
      // #289 ③ / ADR-030: 氏名らしき高確信パターン（敬称連接）を検出し、未 override で送信を保留した状態。
      // hard-block しない soft-gate。route は 409 + suspectedSurfaces を返し、教員 UI が表層提示 + 明示
      // override（acknowledgePii=true で再送）を促す。surfaces は warn 表示用で PII 本文は他に出さない。
      ok: false;
      reason: "pii_warning";
      suspectedSurfaces: string[];
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
  /**
   * PII soft-gate override（acknowledgePii）で送信した事実を `audit_log` に記録する（ADR-030 / NFR04）。
   * **件数のみ**で生の疑わしい氏名は複製しない（ルール4）。送信**前**に呼ぶ契約（監査不能なら送信しない）。
   */
  recordPiiOverride: (params: {
    inputId: string;
    kind: ExtractionKind;
    suspectedNameCount: number;
  }) => Promise<void>;
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

async function defaultRecordPiiOverride(params: {
  inputId: string;
  kind: ExtractionKind;
  suspectedNameCount: number;
}): Promise<void> {
  // gate-first: 監査も role を弾いてから書く (ルール2)。actor はセッション由来 (外部入力を信用しない)。
  const user = await getAuthorizedExtractionUser();
  if (user.schoolId === null) {
    // teacher / school_admin は必ず school 所属。null は壊れたセッション → deny (publish soft-gate と同方針)。
    throw new ForbiddenError();
  }
  await withUserSession(user, (tx) =>
    tx
      .insert(auditLog)
      .values({
        actorUserId: user.uid,
        schoolId: user.schoolId,
        // 対象は教員入力。AI 抽出のための override 立証なので operation=update (publish override と同型)。
        tableName: "teacher_input",
        recordId: params.inputId,
        operation: "update",
        // ★ 件数のみ。生の疑わしい氏名は audit_log に焼き込まない (ルール4 / ADR-030)。
        diff: {
          aiExtractPiiOverride: true,
          suspectedNameCount: params.suspectedNameCount,
          kind: params.kind,
        },
        rowHash: "", // hash chain は audit_log の BEFORE INSERT トリガが計算 (rowHash:"" を渡す)。
        createdBy: user.uid,
        updatedBy: user.uid,
      })
      .then(() => undefined),
  );
}

function defaultDeps(): ExtractTeacherInputDeps {
  return {
    loadTranscript: defaultLoadTranscript,
    loadStaffPiiEntries: defaultLoadStaffPiiEntries,
    recordPiiOverride: defaultRecordPiiOverride,
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
  opts: { acknowledgePii?: boolean } = {},
): Promise<ExtractTeacherInputResult> {
  try {
    const loaded = await deps.loadTranscript(inputId);
    const transcript = loaded?.transcript ?? null;
    if (transcript === null || transcript.trim().length === 0) {
      // 他校/不在、または文字起こし未確定 → 抽出対象なし。
      return { ok: false, reason: "no_transcript" };
    }

    // #289 ③ / ADR-030: 氏名らしき高確信パターン (敬称連接) を Vertex 送信前に soft-gate。検出 & 未 override は
    // **送信せず** warn (pii_warning) を返す (hard-block しない: FP で正当な抽出を阻害しないため warn+override)。
    // route が 409 + surfaces にし、教員 UI が表層提示 + 明示 override (acknowledgePii=true で再送) を促す。
    const suspects = findSuspectedPersonalNames(transcript);
    if (suspects.length > 0 && opts.acknowledgePii !== true) {
      return {
        ok: false,
        reason: "pii_warning",
        // 表層のみ (重複は畳む)。index/生本文等は返さない (warn UI ハイライト用、ルール4)。
        suspectedSurfaces: Array.from(new Set(suspects.map((s) => s.surface))),
      };
    }
    // override (承知の上で送信) は **送信前に** 件数監査する (NFR04: override を立証。監査が落ちたら送信しない
    // = unaudited な override 送信を構造的に作らない fail-safe)。生の疑わしい氏名は記録しない (件数のみ)。
    if (suspects.length > 0) {
      await deps.recordPiiOverride({ inputId, kind, suspectedNameCount: suspects.length });
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
