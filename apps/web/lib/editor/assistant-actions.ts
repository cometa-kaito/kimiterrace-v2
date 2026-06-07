"use server";

import {
  AiDisabledError,
  ExtractFailedError,
  ExtractorNotConfiguredError,
  type ModelClient,
  type RateLimiter,
  UnsupportedFormatError,
  assertAiEnabled,
  createPerSchoolRateLimiter,
  createVertexModelClient,
  extractText,
  findSuspectedPersonalNames,
  findUnmaskedPii,
  maskPII,
  unmaskPII,
} from "@kimiterrace/ai";
import { auditLog } from "@kimiterrace/db";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { MAX_UPLOAD_BYTES, resolveUploadType } from "../teacher-input/upload-validation";
import {
  ASSIST_INPUT_MAX,
  type AssistDraftResult,
  NOTICE_ASSIST_SYSTEM,
  buildNoticeAssistUser,
  parseNoticeProposal,
} from "./assistant-core";
import type { NoticeItem } from "./notice-assignment-core";
import {
  EDITOR_ROLES,
  type EditorActor,
  type EditorTarget,
  parseEditorTarget,
  toEditorActor,
} from "./schedule-core";

/**
 * 段C: エディタ AI アシスタント Server Action（連絡ドラフト）。教員のメモ/発話/**ファイル** → AI 整形 →
 * 連絡(notices) の候補を返す（**保存はしない**。client が確認後に既存 `setNoticesAction` で保存する）。
 *
 * 規律:
 * - ルール4 PII: Vertex 送信前に書式 PII (電話/メール) を `maskPII` でマスク + `findUnmaskedPii` fail-closed。
 *   氏名らしき高確信パターン (ADR-030 soft-gate) は未 override なら送信せず警告。LLM 呼び出しは
 *   `audit_log` に記録 (本文は残さず件数のみ)。`AI_ENABLED` kill-switch を `assertAiEnabled` で尊重。
 *   ファイル抽出テキストも同じ `runNoticeDraft` パイプラインを通すので、マスク/soft-gate/監査は同一。
 * - ルール2 RLS: 監査書込は `withSession` の自校 tx。actor はセッション由来 (外部入力を信用しない)。
 * - 生メモ/応答本文/ファイル内容はログ・監査に出さない。本 action は DB のコンテンツを変更しない (ドラフトのみ)。
 *
 * **本MVP は連絡のみ**。時間割/提出物の AI 化は後続スライス。
 */

const sharedRateLimiter: RateLimiter = createPerSchoolRateLimiter();

let memoModel: ModelClient | null = null;
/** 実 Vertex model を env から遅延生成（construct は lazy = 認証/通信なし、generate 時のみ ADC）。 */
function getModel(): ModelClient {
  if (memoModel) return memoModel;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoModel = createVertexModelClient({ project, location });
  return memoModel;
}

/**
 * エディタのファイル入力で受理する拡張子（テキスト抽出が即動作するもの）。
 * 画像 (png/jpg) は OCR 未配線 (ADR-024 決定3) ゆえ本MVPでは非対応 → `unsupported_format`。
 */
const EDITOR_FILE_EXTS = new Set(["pdf", "docx", "xlsx"]);

/** 監査の record_id（対象の最も具体的な id。school scope は schoolId）。 */
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

/** テスト差し替え用の依存（既定は実 model + プロセス内 rate limiter）。 */
export interface AssistDeps {
  model: ModelClient;
  rateLimiter: RateLimiter;
  nowMs?: number;
}

function defaultDeps(): AssistDeps {
  return { model: getModel(), rateLimiter: sharedRateLimiter };
}

/** target 解決 + 認証 + AI 有効化を共通化（成功で {target, actor}、失敗で畳んだ結果）。 */
async function authorizeAssist(
  scope: unknown,
  targetId: unknown,
): Promise<
  { ok: true; target: EditorTarget; actor: EditorActor } | { ok: false; result: AssistDraftResult }
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
 * 抽出済み/入力済みテキスト → 連絡候補の共通パイプライン（soft-gate → rate → mask → 生成 → 逆マスク →
 * fail-closed → 監査）。text/file 両エントリが本関数を共有する。`source` は監査の区別用。
 */
async function runNoticeDraft(
  target: EditorTarget,
  actor: EditorActor,
  text: string,
  opts: { acknowledgePii?: boolean },
  deps: AssistDeps,
  source: "text" | "file",
): Promise<AssistDraftResult> {
  // ADR-030 PII soft-gate: 敬称連接の氏名らしきパターン検出 → 未 override は送信せず警告。
  const suspects = findSuspectedPersonalNames(text);
  if (suspects.length > 0 && opts.acknowledgePii !== true) {
    return {
      ok: false,
      reason: "pii_warning",
      suspectedSurfaces: Array.from(new Set(suspects.map((s) => s.surface))),
    };
  }

  // per-school レート制限（プロセス内）。マスク/モデル呼び出しより前に弾く。
  const now = deps.nowMs ?? Date.now();
  if (!(await deps.rateLimiter.tryAcquire(actor.schoolId, now))) {
    return { ok: false, reason: "rate_limited" };
  }

  // 書式 PII (電話/メール) をマスク。fail-closed: マスク後に PII 残存なら送らず中止（ルール4）。
  const { masked, dictionary } = maskPII(text, []);
  if (findUnmaskedPii(masked, []).length > 0) {
    return { ok: false, reason: "pii_leak" };
  }

  let notices: NoticeItem[];
  try {
    const res = await deps.model.generate({
      system: NOTICE_ASSIST_SYSTEM,
      user: buildNoticeAssistUser(masked),
    });
    const proposal = parseNoticeProposal(res.text);
    if (!proposal || proposal.length === 0) {
      return { ok: false, reason: "no_result" };
    }
    // 逆マスクして元の表記に戻す。
    notices = proposal.map((n) => ({ ...n, text: unmaskPII(n.text, dictionary) }));
  } catch {
    // モデル/通信障害。本文は出さない。
    return { ok: false, reason: "error" };
  }

  // 逆マスク後の出力にも PII 残存が無いか fail-closed で再チェック（ルール4）。
  for (const n of notices) {
    if (findUnmaskedPii(n.text, []).length > 0) {
      return { ok: false, reason: "pii_leak" };
    }
  }

  // ルール1/4: LLM 呼び出しを audit_log に記録（本文は残さず件数のみ）。override 件数も。
  await withSession(async (tx) => {
    await tx.insert(auditLog).values({
      actorUserId: actor.userId,
      schoolId: actor.schoolId,
      tableName: "daily_data",
      recordId: auditRecordId(target, actor),
      operation: "update",
      diff: {
        aiAssist: source === "file" ? "notices_draft_file" : "notices_draft",
        noticeCount: notices.length,
        suspectedNameCount: suspects.length,
        scope: target.scope,
      },
      rowHash: "",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
  });

  return { ok: true, notices };
}

/**
 * 教員のメモ/発話テキストを AI で「連絡」候補に整形して返す（保存しない）。
 * すべてのエラーを {@link AssistDraftResult} に畳む（throw しない）。
 */
export async function assistDraftNoticesAction(
  scope: unknown,
  targetId: unknown,
  rawText: unknown,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssistDraftResult> {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (text.length > ASSIST_INPUT_MAX) {
    return { ok: false, reason: "too_long" };
  }

  const auth = await authorizeAssist(scope, targetId);
  if (!auth.ok) {
    return auth.result;
  }

  return runNoticeDraft(auth.target, auth.actor, text, opts, deps, "text");
}

/**
 * アップロードファイル (PDF / Word / Excel) からテキストを抽出し、AI で「連絡」候補に整形して返す
 * （保存しない）。画像 (png/jpg) は OCR 未配線 (ADR-024 決定3) のため本MVP非対応。
 * 抽出後は {@link runNoticeDraft} を通すので PII マスク/soft-gate/監査は text 経路と同一（ルール4）。
 */
export async function assistDraftNoticesFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssistDraftResult> {
  const file = formData?.get?.("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: "empty" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  // MIME allowlist（ファイル名でなく MIME を一次ソース）。画像/レガシー Office 等は弾く。
  const uploadType = resolveUploadType(file.type);
  if (!uploadType || !EDITOR_FILE_EXTS.has(uploadType.ext)) {
    return { ok: false, reason: "unsupported_format" };
  }

  const auth = await authorizeAssist(scope, targetId);
  if (!auth.ok) {
    return auth.result;
  }

  let text: string;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // OCR は渡さない（画像は上で弾き済み・PDF/DOCX/XLSX のみ到達）。抽出テキストは未マスク（ルール4）。
    const extracted = await extractText({ bytes, mimeType: file.type, filename: file.name });
    text = extracted.text.trim().slice(0, ASSIST_INPUT_MAX);
  } catch (e) {
    // 形式未対応/未配線（画像 OCR 等）は unsupported、パース失敗（破損/暗号化）は extract_failed。
    if (e instanceof UnsupportedFormatError || e instanceof ExtractorNotConfiguredError) {
      return { ok: false, reason: "unsupported_format" };
    }
    if (e instanceof ExtractFailedError) {
      return { ok: false, reason: "extract_failed" };
    }
    return { ok: false, reason: "extract_failed" };
  }

  if (text.length === 0) {
    return { ok: false, reason: "no_text" };
  }

  return runNoticeDraft(auth.target, auth.actor, text, opts, deps, "file");
}
