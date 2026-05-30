import { createHash } from "node:crypto";
import type { ModelClient, ModelUsage } from "./model/client.js";
import { maskPII, unmaskDeep } from "./pii/mask.js";
import type { MaskOptions, PiiEntry } from "./pii/types.js";
import { buildSystemPrompt, buildUserPrompt, repairHint } from "./prompt/build.js";
import type { RateLimiter } from "./rate-limit.js";
import { type Extraction, type ExtractionKind, schemaForKind } from "./schema/extraction.js";

/**
 * F03 構造化抽出オーケストレータ。
 *
 * パイプライン（CLAUDE.md ルール4 / ADR-017）:
 *   1. PII マスキング（送信前トークン化）
 *   2. マスク後テキストの SHA-256 を監査用に算出（生テキストは保存しない）
 *   3. インジェクション境界付きプロンプト構築 → ModelClient で生成
 *   4. JSON parse → Zod validate、失敗時は修復ヒント付きで最大 2 回リトライ
 *   5. 成功した構造化結果のトークンを逆変換（unmask）して返す
 *
 * モデル呼び出しは `ModelClient` に依存逆転されており、テストはフェイクで全分岐を検証できる。
 * DB 監査（ai_extractions への INSERT）はパッケージ境界を越えないよう本関数の外で行う:
 * 本関数は監査に必要な値（confidence / model_version / hash / status / usage）を結果に含め、
 * 呼び出し側が `toAiExtractionInsert`（./audit.ts）で行へ変換し withTenantContext 内で INSERT する。
 */

export interface StructureRequest {
  kind: ExtractionKind;
  /** 教員の自由入力（F01 抽出テキスト / F02 音声・チャット）。 */
  input: string;
  model: ModelClient;
  /** ロスター由来の確実な PII（生徒・保護者・職員氏名など）。マスキングで確定置換する。 */
  piiEntries?: readonly PiiEntry[];
  /** PII パターン検出（電話・メール）の ON/OFF。既定で有効。 */
  maskOptions?: MaskOptions;
  /** スキーマ違反時のリトライ上限（既定 2、ADR-017）。 */
  maxRetries?: number;
  /** レート制限を強制する場合に渡す（school 単位）。 */
  rateLimiter?: RateLimiter;
  /** rateLimiter のキー（通常 school_id）。 */
  schoolId?: string;
  /** rateLimiter 判定に使う現在時刻。既定 `Date.now()`。 */
  nowMs?: number;
}

export interface StructureResult {
  status: "success" | "failed";
  kind: ExtractionKind;
  /** 逆変換済みの構造化結果。失敗時は null。 */
  extraction: Extraction | null;
  /** 必須の自己評価値（ADR-017）。失敗時は null。 */
  confidenceScore: number | null;
  modelVersion: string;
  usage: ModelUsage;
  /** マスク後入力の SHA-256（ai_extractions.raw_input_hash）。 */
  rawInputHash: string;
  /** 実行した生成回数（1 = 初回成功）。 */
  attempts: number;
  /** 失敗時のスキーマ/パースエラー要約。 */
  errorMessage: string | null;
}

/** レート上限超過。呼び出し側は HTTP 429 にマップする。 */
export class RateLimitExceededError extends Error {
  constructor(public readonly schoolId: string) {
    super(`F03 rate limit exceeded for school ${schoolId}`);
    this.name = "RateLimitExceededError";
  }
}

const EMPTY_USAGE: ModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function structureContent(req: StructureRequest): Promise<StructureResult> {
  const maxRetries = req.maxRetries ?? 2;

  // レート制限（任意）。マスキングやモデル呼び出しより前に弾く。
  if (req.rateLimiter && req.schoolId) {
    const now = req.nowMs ?? Date.now();
    if (!req.rateLimiter.tryAcquire(req.schoolId, now)) {
      throw new RateLimitExceededError(req.schoolId);
    }
  }

  const { masked, dictionary } = maskPII(req.input, req.piiEntries ?? [], req.maskOptions ?? {});
  const rawInputHash = sha256Hex(masked);
  const system = buildSystemPrompt(req.kind);
  const baseUser = buildUserPrompt(masked);
  const schema = schemaForKind(req.kind);

  let lastError = "";
  let usage: ModelUsage = EMPTY_USAGE;
  let modelVersion = "";

  // 初回 + リトライ（maxRetries 回）の計 maxRetries+1 回まで試行。
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const user = attempt === 1 ? baseUser : `${baseUser}${repairHint(lastError)}`;
    const res = await req.model.generate({ system, user });
    usage = res.usage;
    modelVersion = res.modelVersion;

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch (e) {
      lastError = `JSON parse error: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      continue;
    }

    // 逆変換（マスクしたトークンを元の PII へ戻す）。
    const extraction = unmaskDeep(parsed.data, dictionary) as Extraction;
    return {
      status: "success",
      kind: req.kind,
      extraction,
      confidenceScore: extraction.confidenceScore,
      modelVersion,
      usage,
      rawInputHash,
      attempts: attempt,
      errorMessage: null,
    };
  }

  return {
    status: "failed",
    kind: req.kind,
    extraction: null,
    confidenceScore: null,
    modelVersion,
    usage,
    rawInputHash,
    attempts: maxRetries + 1,
    errorMessage: lastError,
  };
}
