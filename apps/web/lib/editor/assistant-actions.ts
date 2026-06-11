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
import { resolveUploadType } from "../teacher-input/upload-validation";
import {
  ASSIST_INPUT_MAX,
  type AssignmentDraftResult,
  type AssistDraftError,
  type AssistDraftResult,
  type DraftSection,
  SECTION_ASSIST_SYSTEM,
  type ScheduleDraftResult,
  buildSectionAssistUser,
  jstDateLabel,
  parseAssignmentProposal,
  parseNoticeProposal,
  parseScheduleProposal,
} from "./assistant-core";
import type { AssignmentItem, NoticeItem } from "./notice-assignment-core";
import {
  EDITOR_ROLES,
  type EditorActor,
  type EditorTarget,
  type ScheduleItem,
  parseEditorTarget,
  toEditorActor,
} from "./schedule-core";

/**
 * 段C: エディタ AI アシスタント Server Action（予定/連絡/提出物ドラフト）。教員のメモ/発話/**ファイル** →
 * AI 整形 → 各セクション (schedules/notices/assignments) の候補を返す（**保存はしない**。client が確認後に
 * 既存 `setScheduleAction`/`setNoticesAction`/`setAssignmentsAction` で保存する）。
 *
 * 規律:
 * - ルール4 PII: Vertex 送信前に書式 PII (電話/メール) を `maskPII` でマスク + `findUnmaskedPii` fail-closed。
 *   氏名らしき高確信パターン (ADR-030 soft-gate) は未 override なら送信せず警告。LLM 呼び出しは
 *   `audit_log` に記録 (本文は残さず件数のみ)。`AI_ENABLED` kill-switch を `assertAiEnabled` で尊重。
 *   全セクション・text/file 両エントリが同じ `runSectionDraft` パイプラインを通すので、マスク/soft-gate/
 *   監査は同一（セクション差分は system プロンプト/パーサ/逆マスク対象列のみ = {@link SectionSpec}）。
 * - ルール2 RLS: 監査書込は `withSession` の自校 tx。actor はセッション由来 (外部入力を信用しない)。
 * - 生メモ/応答本文/ファイル内容はログ・監査に出さない。本 action は DB のコンテンツを変更しない (ドラフトのみ)。
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

/**
 * エディタファイル入力のサイズ上限 (10MB)。Server Action 経路ゆえ next.config の
 * `serverActions.bodySizeLimit` (12MB = 本値 + multipart 余白) と整合させる。大容量 (50MB) の
 * F01 教員アップロードは Route Handler 経路で別管理 (#695 Reviewer High-1)。
 */
const ASSIST_FILE_MAX_BYTES = 10 * 1024 * 1024;

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
 * セクションごとの差分（パーサ・逆マスク対象列・fail-closed 検査対象の文字列集合）を共通本体に注入する。
 * これ以外（soft-gate/rate/mask/監査/エラー畳み）は全セクション同一。
 */
type SectionSpec<T> = {
  /** モデル生 JSON → 検証済み要素配列（不正/空は null/[]）。assistant-core の parse*Proposal。 */
  parse: (text: string) => T[] | null;
  /** dictionary で {{token}} を元表記へ逆マスク（連絡=text / 予定=subject・note・location・targetAudience / 提出物=subject・task）。 */
  unmask: (item: T, dict: Parameters<typeof unmaskPII>[1]) => T;
  /** fail-closed のマスク漏れ検査対象の文字列（deadline 等の日付は PII でないため含めない）。 */
  strings: (item: T) => string[];
};

const NOTICE_SPEC: SectionSpec<NoticeItem> = {
  parse: parseNoticeProposal,
  unmask: (n, dict) => ({ ...n, text: unmaskPII(n.text, dict) }),
  strings: (n) => [n.text],
};

const SCHEDULE_SPEC: SectionSpec<ScheduleItem> = {
  parse: parseScheduleProposal,
  unmask: (s, dict) => ({
    ...s,
    subject: unmaskPII(s.subject, dict),
    ...(s.note !== undefined ? { note: unmaskPII(s.note, dict) } : {}),
    ...(s.location !== undefined ? { location: unmaskPII(s.location, dict) } : {}),
    ...(s.targetAudience !== undefined
      ? { targetAudience: unmaskPII(s.targetAudience, dict) }
      : {}),
  }),
  strings: (s) =>
    [s.subject, s.note, s.location, s.targetAudience].filter((x): x is string => x !== undefined),
};

const ASSIGNMENT_SPEC: SectionSpec<AssignmentItem> = {
  parse: parseAssignmentProposal,
  unmask: (a, dict) => ({
    ...a,
    subject: unmaskPII(a.subject, dict),
    task: unmaskPII(a.task, dict),
  }),
  strings: (a) => [a.subject, a.task],
};

/**
 * 抽出済み/入力済みテキスト → セクション候補の共通パイプライン（soft-gate → rate → mask → 生成 →
 * 逆マスク → fail-closed → 監査）。全セクション・text/file 両エントリが本関数を共有する。`section` は
 * system プロンプト/監査ラベルを、`spec` はパーサ/逆マスク/検査対象を与える。`source` は監査の区別用。
 */
async function runSectionDraft<T>(
  section: DraftSection,
  spec: SectionSpec<T>,
  target: EditorTarget,
  actor: EditorActor,
  text: string,
  opts: { acknowledgePii?: boolean },
  deps: AssistDeps,
  source: "text" | "file",
): Promise<{ ok: true; items: T[] } | AssistDraftError> {
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

  let items: T[];
  try {
    const res = await deps.model.generate({
      system: SECTION_ASSIST_SYSTEM[section],
      // 基準日（今日・JST）を渡し、「明日」等の相対表現をモデルが具体的な日付へ変換できるようにする。
      user: buildSectionAssistUser(section, masked, jstDateLabel(now)),
    });
    const proposal = spec.parse(res.text);
    if (!proposal || proposal.length === 0) {
      return { ok: false, reason: "no_result" };
    }
    // 逆マスクして元の表記に戻す（セクションごとの対象列）。
    items = proposal.map((it) => spec.unmask(it, dictionary));
  } catch {
    // モデル/通信障害。本文は出さない。
    return { ok: false, reason: "error" };
  }

  // 逆マスク後の出力にも PII 残存が無いか fail-closed で再チェック（ルール4・全文字列フィールド）。
  for (const it of items) {
    for (const field of spec.strings(it)) {
      if (findUnmaskedPii(field, []).length > 0) {
        return { ok: false, reason: "pii_leak" };
      }
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
        aiAssist: source === "file" ? `${section}_draft_file` : `${section}_draft`,
        itemCount: items.length,
        suspectedNameCount: suspects.length,
        scope: target.scope,
      },
      rowHash: "",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
  });

  return { ok: true, items };
}

/** テキスト入力 → セクション候補（共通: 入力長検証 → 認証 → {@link runSectionDraft}）。 */
async function draftSectionFromText<T>(
  section: DraftSection,
  spec: SectionSpec<T>,
  scope: unknown,
  targetId: unknown,
  rawText: unknown,
  opts: { acknowledgePii?: boolean },
  deps: AssistDeps,
): Promise<{ ok: true; items: T[] } | AssistDraftError> {
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
  return runSectionDraft(section, spec, auth.target, auth.actor, text, opts, deps, "text");
}

/**
 * ファイル入力 (PDF/Word/Excel) → セクション候補（共通: 形式/サイズ検証 → 認証 → テキスト抽出 →
 * {@link runSectionDraft}）。画像 (png/jpg) は OCR 未配線 (ADR-024 決定3) のため非対応。
 */
async function draftSectionFromFile<T>(
  section: DraftSection,
  spec: SectionSpec<T>,
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean },
  deps: AssistDeps,
): Promise<{ ok: true; items: T[] } | AssistDraftError> {
  const file = formData?.get?.("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: "empty" };
  }
  if (file.size > ASSIST_FILE_MAX_BYTES) {
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

  return runSectionDraft(section, spec, auth.target, auth.actor, text, opts, deps, "file");
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
  const r = await draftSectionFromText(
    "notices",
    NOTICE_SPEC,
    scope,
    targetId,
    rawText,
    opts,
    deps,
  );
  return r.ok ? { ok: true, notices: r.items } : r;
}

/** 教員のメモ/発話テキストを AI で「予定(時間割)」候補に整形して返す（保存しない）。 */
export async function assistDraftScheduleAction(
  scope: unknown,
  targetId: unknown,
  rawText: unknown,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<ScheduleDraftResult> {
  const r = await draftSectionFromText(
    "schedules",
    SCHEDULE_SPEC,
    scope,
    targetId,
    rawText,
    opts,
    deps,
  );
  return r.ok ? { ok: true, schedules: r.items } : r;
}

/** 教員のメモ/発話テキストを AI で「提出物(課題)」候補に整形して返す（保存しない）。 */
export async function assistDraftAssignmentAction(
  scope: unknown,
  targetId: unknown,
  rawText: unknown,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssignmentDraftResult> {
  const r = await draftSectionFromText(
    "assignments",
    ASSIGNMENT_SPEC,
    scope,
    targetId,
    rawText,
    opts,
    deps,
  );
  return r.ok ? { ok: true, assignments: r.items } : r;
}

/**
 * アップロードファイル (PDF / Word / Excel) からテキストを抽出し、AI で「連絡」候補に整形して返す
 * （保存しない）。画像 (png/jpg) は OCR 未配線 (ADR-024 決定3) のため本MVP非対応。
 * 抽出後は {@link runSectionDraft} を通すので PII マスク/soft-gate/監査は text 経路と同一（ルール4）。
 */
export async function assistDraftNoticesFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssistDraftResult> {
  const r = await draftSectionFromFile(
    "notices",
    NOTICE_SPEC,
    scope,
    targetId,
    formData,
    opts,
    deps,
  );
  return r.ok ? { ok: true, notices: r.items } : r;
}

/** ファイル (PDF/Word/Excel) から AI で「予定(時間割)」候補に整形して返す（保存しない）。 */
export async function assistDraftScheduleFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<ScheduleDraftResult> {
  const r = await draftSectionFromFile(
    "schedules",
    SCHEDULE_SPEC,
    scope,
    targetId,
    formData,
    opts,
    deps,
  );
  return r.ok ? { ok: true, schedules: r.items } : r;
}

/** ファイル (PDF/Word/Excel) から AI で「提出物(課題)」候補に整形して返す（保存しない）。 */
export async function assistDraftAssignmentFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssignmentDraftResult> {
  const r = await draftSectionFromFile(
    "assignments",
    ASSIGNMENT_SPEC,
    scope,
    targetId,
    formData,
    opts,
    deps,
  );
  return r.ok ? { ok: true, assignments: r.items } : r;
}
