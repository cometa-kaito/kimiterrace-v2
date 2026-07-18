import { createHash } from "node:crypto";
import {
  AiDisabledError,
  ExtractFailedError,
  ExtractorNotConfiguredError,
  type OcrClient,
  type RateLimiter,
  UnsupportedFormatError,
  assertAiEnabled,
  createGeminiOcrClient,
  extractText,
} from "@kimiterrace/ai";
import { auditLog } from "@kimiterrace/db";
import { createLogger } from "@kimiterrace/observability";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type AllowedUploadType,
  hasValidImageMagicBytes,
  resolveUploadType,
} from "../teacher-input/upload-validation";
import type { AssistDraftError } from "./assistant-core";
import {
  EDITOR_ROLES,
  type EditorActor,
  type EditorTarget,
  parseEditorTarget,
  toEditorActor,
} from "./schedule-core";

/**
 * エディタ AI のファイル入力（認可・検証・テキスト抽出・OCR egress 三段ガード）の **共有実装**。
 *
 * 元は `assistant-actions.ts`（"use server"）のモジュール私有ロジックだったものを、P1 写真取込
 * （photo-import-actions.ts・設計 D5）と共有するため通常モジュールへ抽出した（"use server" は
 * 非 async の export ができず、私有のままでは**実装の複製**でしか共有できないため）。挙動は不変:
 * - 検証: File 実在 / サイズ上限 / MIME allowlist（{@link validateEditorUpload}）
 * - 三段ガード（ADR-038 / ADR-024 決定2）: (a) OCR egress が発生しうる入力（画像/PDF）は egress の
 *   **前に** per-school rate を取得 (NFR06)、(b) 実際に OCR を通したら egress を `audit_log` に記録
 *   （素材 SHA-256 + 文字数のみ・本文非保存 = ルール4）、(c) 抽出テキストの PII マスク/soft-gate は
 *   下流（runSectionDraft / assistant-chat の既存パイプライン）が担う。
 */

/**
 * エディタのファイル入力で受理する拡張子。文書/表（pdf/docx/xlsx/csv）は egress なしのローカル抽出、
 * 画像（png/jpg）は Gemini マルチモーダル OCR（ADR-038・旧 ADR-024 決定2 Vision を supersede）で配線。
 */
export const EDITOR_FILE_EXTS = new Set(["pdf", "docx", "xlsx", "csv", "png", "jpg"]);

/** 画像（OCR 外部委託が発生する）拡張子。rate 前置 + OCR egress 監査の判定に使う。 */
export const IMAGE_FILE_EXTS = new Set(["png", "jpg"]);

/**
 * エディタファイル入力のサイズ上限 (10MB)。Server Action 経路ゆえ next.config の
 * `serverActions.bodySizeLimit` (12MB = 本値 + multipart 余白) と整合させる。大容量 (50MB) の
 * F01 教員アップロードは Route Handler 経路で別管理 (#695 Reviewer High-1)。
 */
export const ASSIST_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** OCR egress 監査の best-effort 失敗等を構造化記録する（Cloud Logging・本文/PII は出さない）。 */
const assistLogger = createLogger("editor-assist");

let memoOcr: OcrClient | null = null;
/**
 * 画像 OCR クライアント（Gemini マルチモーダル直送・ADR-038）を遅延生成。Vertex と同一 project/location
 * （asia-northeast1）に閉じる（NFR07 データ越境ゼロ）。construct は lazy（認証/通信なし、recognize 時のみ ADC）。
 */
export function getSharedOcrClient(): OcrClient {
  if (memoOcr) return memoOcr;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoOcr = createGeminiOcrClient({ project, location });
  return memoOcr;
}

/** 監査の record_id（対象の最も具体的な id。school scope は schoolId）。 */
export function auditRecordId(target: EditorTarget, actor: EditorActor): string {
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

/** target 解決 + 認証 + AI 有効化を共通化（成功で {target, actor}、失敗で畳んだ結果）。 */
export async function authorizeAssist(
  scope: unknown,
  targetId: unknown,
): Promise<
  { ok: true; target: EditorTarget; actor: EditorActor } | { ok: false; result: AssistDraftError }
> {
  const target = parseEditorTarget(scope, targetId);
  if (!target) {
    return { ok: false, result: { ok: false, reason: "error" } };
  }
  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return { ok: false, result: { ok: false, reason: "forbidden" } };
  }
  // AI_ENABLED kill-switch（#289 / ルール4）。
  try {
    assertAiEnabled();
  } catch (e) {
    if (e instanceof AiDisabledError) {
      return { ok: false, result: { ok: false, reason: "disabled" } };
    }
    throw e;
  }
  return { ok: true, target, actor };
}

/**
 * OCR 外部委託（画像 / スキャン PDF → Vertex Gemini, ADR-038 / 旧 ADR-024 決定2.2）の監査。素材が Vertex に
 * 送られた事実を who / school / 対象 / 素材 SHA-256 / メディア種別 / 抽出文字数で記録する
 * （**素材本体・抽出本文は残さない** = ルール4）。egress は extract 時点で発生済ゆえ、no_text / 後続 draft
 * 生成の成否に関わらず本監査を残す（fail-safe）。`mediaType` で画像 OCR と PDF OCR を監査上区別できる。
 */
export async function writeOcrEgressAudit(
  actor: EditorActor,
  target: EditorTarget,
  sourceBytes: Uint8Array,
  mediaType: string,
  charCount: number,
): Promise<void> {
  // 互換のためキー名は imageSha256 を維持しつつ、PDF egress を判別できるよう mediaType を併記する。
  const imageSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  await withSession(async (tx) => {
    await tx.insert(auditLog).values({
      actorUserId: actor.userId,
      schoolId: actor.schoolId,
      tableName: "daily_data",
      recordId: auditRecordId(target, actor),
      operation: "update",
      diff: {
        ocrEgress: true,
        backend: "gemini",
        mediaType,
        imageSha256,
        charCount,
        scope: target.scope,
      },
      rowHash: "",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
  });
}

/** 検証済みアップロード（{@link validateEditorUpload} の成功形）。 */
export interface ValidatedEditorUpload {
  file: File;
  uploadType: AllowedUploadType;
  /** 画像（常に OCR egress）。 */
  isImage: boolean;
  /** OCR egress が発生し**うる**（画像は常に・PDF はスキャン時のみ）。rate 前置の判定。 */
  mightEgress: boolean;
}

export type EditorUploadValidationError = {
  ok: false;
  reason: "empty" | "too_large" | "unsupported_format";
};

/**
 * エディタファイル入力の形式/サイズ検証（認可より前・DB 非依存）。`imageOnly` は写真取込（P1）用に
 * 受理を png/jpg へ絞る（文書/表は既存の AI パネル添付経路が担う）。
 */
export function validateEditorUpload(
  formData: FormData,
  opts: { imageOnly?: boolean } = {},
): { ok: true; upload: ValidatedEditorUpload } | EditorUploadValidationError {
  const file = formData?.get?.("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: "empty" };
  }
  if (file.size > ASSIST_FILE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  // MIME allowlist（ファイル名でなく MIME を一次ソース）。レガシー Office 等は弾く。
  const uploadType = resolveUploadType(file.type);
  if (!uploadType || !EDITOR_FILE_EXTS.has(uploadType.ext)) {
    return { ok: false, reason: "unsupported_format" };
  }
  const isImage = IMAGE_FILE_EXTS.has(uploadType.ext);
  if (opts.imageOnly && !isImage) {
    return { ok: false, reason: "unsupported_format" };
  }
  // PDF はテキストレイヤがあればローカル抽出（egress なし）、スキャン PDF は Gemini 直送 OCR に
  // フォールバックする（egress が発生しうる・ADR-038）。画像は常に OCR egress。
  const mightEgress = isImage || uploadType.ext === "pdf";
  return { ok: true, upload: { file, uploadType, isImage, mightEgress } };
}

/** {@link extractEditorUploadText} の依存（テストはフェイク注入）。 */
export interface EditorUploadExtractDeps {
  rateLimiter: RateLimiter;
  /** 画像 OCR クライアント（ADR-038）。未指定時のみ実 Gemini OCR を遅延生成。 */
  ocr?: OcrClient;
  nowMs?: number;
  /** 抽出テキストの上限（超過分は切り捨て・監査 charCount も切り捨て後）。経路の入力上限に合わせる。 */
  maxChars?: number;
}

export type EditorUploadExtraction =
  | { ok: true; text: string; ocrUsed: boolean; mightEgress: boolean }
  | { ok: false; reason: "rate_limited" | "unsupported_format" | "extract_failed" | "no_text" };

/**
 * 検証済みアップロード → 抽出テキスト（OCR egress 三段ガードの (a)(b) を内包）。認可済みで呼ぶこと。
 * 戻りの `mightEgress` が true のとき rate は取得済み（呼び出し側の下流 LLM 呼び出しは二重取得しない
 * = `skipRateLimit`、NFR06）。抽出テキストは **PII 未マスク**（マスク/soft-gate は下流の責務 = ルール4）。
 */
export async function extractEditorUploadText(
  upload: ValidatedEditorUpload,
  actor: EditorActor,
  target: EditorTarget,
  deps: EditorUploadExtractDeps,
): Promise<EditorUploadExtraction> {
  const { file, isImage, mightEgress } = upload;
  // 画像 / PDF は OCR egress が発生しうる。コスト/越境最小化のため egress の**前に** per-school rate を
  // 取る (NFR06)。docx/xlsx/csv は egress なしのローカル抽出ゆえ、下流の LLM 呼び出し側でのみ rate を取る。
  const now = deps.nowMs ?? Date.now();
  if (mightEgress && !(await deps.rateLimiter.tryAcquire(actor.schoolId, now))) {
    return { ok: false, reason: "rate_limited" };
  }

  let text: string;
  let bytes: Uint8Array;
  let ocrUsed = false;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    // 画像は OCR が画素を読むだけで形式検証をしないため、**egress の前に**宣言 MIME と先頭マジックバイトの整合を
    // 検査する（upload route と同一不変条件 `hasValidImageMagicBytes`）。偽装/非画像バイト（image/png を名乗る
    // 任意バイト列等）を Vertex Gemini に直送しない＝外部委託の境界（ルール4）。PDF/Office は抽出器パースが
    // fail-close（422）で内容を検証するので対象外（非画像 MIME は常に true で素通り）。
    if (isImage && !hasValidImageMagicBytes(bytes, file.type)) {
      return { ok: false, reason: "unsupported_format" };
    }
    // 画像 / PDF は OCR クライアントを注入 (ADR-038 Gemini 直送)。PDF はテキストレイヤがあれば OCR を使わず
    // ローカル抽出のまま（フォールバックはスキャン PDF のみ）。docx/xlsx/csv は egress なしのローカル抽出。
    const extracted = await extractText(
      { bytes, mimeType: file.type, filename: file.name },
      mightEgress ? { ocr: deps.ocr ?? getSharedOcrClient() } : {},
    );
    text = extracted.text.trim();
    if (deps.maxChars !== undefined) {
      text = text.slice(0, deps.maxChars);
    }
    // 実際に OCR を通したか（画像は常に true、PDF はスキャン時のみ true）。egress 監査の判定に使う。
    ocrUsed = extracted.meta?.ocrUsed === true;
  } catch (e) {
    // 形式未対応/未配線は unsupported、パース失敗（破損/暗号化）は extract_failed。
    if (e instanceof UnsupportedFormatError || e instanceof ExtractorNotConfiguredError) {
      return { ok: false, reason: "unsupported_format" };
    }
    if (e instanceof ExtractFailedError) {
      return { ok: false, reason: "extract_failed" };
    }
    return { ok: false, reason: "extract_failed" };
  }

  // OCR egress 監査 (ADR-024 決定2.2 / ADR-038)。実際に OCR を通した時だけ記録する（テキスト PDF は
  // egress なし＝ocrUsed=false で監査しない）。egress は上の extract で発生済ゆえ、no_text や後続 draft の
  // 成否に関わらず残す (fail-safe・本文は残さず画像/PDF ハッシュ+文字数のみ)。
  if (ocrUsed) {
    // 監査 INSERT が一時 DB 障害で失敗しても **本処理は止めない**（fail-safe）。egress 済のまま 500 で教員を
    // ブロックしても egress は取り消せず最悪（外部委託は完了済・ユーザーは詰まる・監査も残らない）。失敗時は
    // egress 完了の痕跡を構造化ログ（Cloud Logging で検知可能・PII/本文は出さない）に残してから degrade する。
    try {
      await writeOcrEgressAudit(actor, target, bytes, file.type, text.length);
    } catch (auditError) {
      assistLogger.error(
        {
          // 「誰の egress が未監査か」を追跡できるよう actor を残す（uid は stable ID・ルール4 安全代替）。
          actorUserId: actor.userId,
          scope: target.scope,
          schoolId: actor.schoolId,
          mediaType: file.type,
          charCount: text.length,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        },
        "OCR egress audit write failed after egress occurred",
      );
    }
  }

  if (text.length === 0) {
    return { ok: false, reason: "no_text" };
  }

  return { ok: true, text, ocrUsed, mightEgress };
}
