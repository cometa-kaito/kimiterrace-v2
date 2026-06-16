"use server";

import { createHash } from "node:crypto";
import {
  AiDisabledError,
  ExtractFailedError,
  ExtractorNotConfiguredError,
  type ModelClient,
  type OcrClient,
  type RateLimiter,
  UnsupportedFormatError,
  assertAiEnabled,
  createGeminiOcrClient,
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
  ALL_ASSIST_SYSTEM,
  ASSIST_INPUT_MAX,
  type AllDraft,
  type AllDraftResult,
  type AssignmentDraftResult,
  type AssistDraftError,
  type AssistDraftResult,
  SECTION_ASSIST_SYSTEM,
  type ScheduleDraftResult,
  buildAllAssistUser,
  buildSectionAssistUser,
  jstDateLabel,
  parseAllProposal,
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
 *   予定/連絡/提出物/おまかせ・text/file 全経路が同じ `runSectionDraft` パイプラインを通すので、マスク/
 *   soft-gate/監査は同一（経路差分は system プロンプト/パーサ/逆マスク対象列のみ = {@link DraftSpec}）。
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

let memoOcr: OcrClient | null = null;
/**
 * 画像 OCR クライアント（Gemini マルチモーダル直送・ADR-038）を遅延生成。Vertex と同一 project/location
 * （asia-northeast1）に閉じる（NFR07 データ越境ゼロ）。construct は lazy（認証/通信なし、recognize 時のみ ADC）。
 */
function getOcrClient(): OcrClient {
  if (memoOcr) return memoOcr;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoOcr = createGeminiOcrClient({ project, location });
  return memoOcr;
}

/**
 * エディタのファイル入力で受理する拡張子。文書/表（pdf/docx/xlsx/csv）は egress なしのローカル抽出、
 * 画像（png/jpg）は Gemini マルチモーダル OCR（ADR-038・旧 ADR-024 決定2 Vision を supersede）で配線。
 */
const EDITOR_FILE_EXTS = new Set(["pdf", "docx", "xlsx", "csv", "png", "jpg"]);

/** 画像（OCR 外部委託が発生する）拡張子。rate 前置 + OCR egress 監査の判定に使う。 */
const IMAGE_FILE_EXTS = new Set(["png", "jpg"]);

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

/**
 * OCR 外部委託（画像 / スキャン PDF → Vertex Gemini, ADR-038 / 旧 ADR-024 決定2.2）の監査。素材が Vertex に
 * 送られた事実を who / school / 対象 / 素材 SHA-256 / メディア種別 / 抽出文字数で記録する
 * （**素材本体・抽出本文は残さない** = ルール4）。egress は extract 時点で発生済ゆえ、no_text / 後続 draft
 * 生成の成否に関わらず本監査を残す（fail-safe）。`mediaType` で画像 OCR と PDF OCR を監査上区別できる。
 */
async function writeOcrEgressAudit(
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

/** テスト差し替え用の依存（既定は実 model + プロセス内 rate limiter + 実 OCR）。 */
export interface AssistDeps {
  model: ModelClient;
  rateLimiter: RateLimiter;
  /** 画像 OCR クライアント（ADR-038）。未指定時のみ実 Gemini OCR を遅延生成（テストはフェイク注入）。 */
  ocr?: OcrClient;
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
type DraftSpec<T> = {
  /** system プロンプト（セクション別 or おまかせ分類）。 */
  system: string;
  /** user プロンプト構築（マスク済み入力 + 基準日ラベル）。 */
  buildUser: (masked: string, dateLabel: string) => string;
  /** 監査ラベルの基底（text は `${auditBase}`、file は `${auditBase}_file`）。 */
  auditBase: string;
  /** モデル生 JSON → 検証済み要素配列（不正/空は null/[]）。assistant-core の parse*Proposal。 */
  parse: (text: string) => T[] | null;
  /** dictionary で {{token}} を元表記へ逆マスク（連絡=text / 予定=subject・note・location・targetAudience / 提出物=subject・task）。 */
  unmask: (item: T, dict: Parameters<typeof unmaskPII>[1]) => T;
  /** fail-closed のマスク漏れ検査対象の文字列（deadline 等の日付は PII でないため含めない）。 */
  strings: (item: T) => string[];
};

const NOTICE_SPEC: DraftSpec<NoticeItem> = {
  system: SECTION_ASSIST_SYSTEM.notices,
  buildUser: (masked, dateLabel) => buildSectionAssistUser("notices", masked, dateLabel),
  auditBase: "notices_draft",
  parse: parseNoticeProposal,
  unmask: (n, dict) => ({ ...n, text: unmaskPII(n.text, dict) }),
  strings: (n) => [n.text],
};

const SCHEDULE_SPEC: DraftSpec<ScheduleItem> = {
  system: SECTION_ASSIST_SYSTEM.schedules,
  buildUser: (masked, dateLabel) => buildSectionAssistUser("schedules", masked, dateLabel),
  auditBase: "schedules_draft",
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

const ASSIGNMENT_SPEC: DraftSpec<AssignmentItem> = {
  system: SECTION_ASSIST_SYSTEM.assignments,
  buildUser: (masked, dateLabel) => buildSectionAssistUser("assignments", masked, dateLabel),
  auditBase: "assignments_draft",
  parse: parseAssignmentProposal,
  unmask: (a, dict) => ({
    ...a,
    subject: unmaskPII(a.subject, dict),
    task: unmaskPII(a.task, dict),
  }),
  strings: (a) => [a.subject, a.task],
};

/**
 * 「おまかせ」分類スペック（ADR-036）。1 入力を 3 セクション束 ({@link AllDraft}) として 1 件扱いし、
 * 逆マスク/fail-closed を全セクションのフィールドへ適用する（per-section の unmask/strings を再利用）。
 */
const ALL_SPEC: DraftSpec<AllDraft> = {
  system: ALL_ASSIST_SYSTEM,
  buildUser: buildAllAssistUser,
  auditBase: "all_draft",
  parse: (text) => {
    const bundle = parseAllProposal(text);
    return bundle ? [bundle] : null;
  },
  unmask: (b, dict) => ({
    schedules: b.schedules.map((s) => SCHEDULE_SPEC.unmask(s, dict)),
    notices: b.notices.map((n) => NOTICE_SPEC.unmask(n, dict)),
    assignments: b.assignments.map((a) => ASSIGNMENT_SPEC.unmask(a, dict)),
  }),
  strings: (b) => [
    ...b.schedules.flatMap((s) => SCHEDULE_SPEC.strings(s)),
    ...b.notices.flatMap((n) => NOTICE_SPEC.strings(n)),
    ...b.assignments.flatMap((a) => ASSIGNMENT_SPEC.strings(a)),
  ],
};

/**
 * 抽出済み/入力済みテキスト → ドラフト候補の共通パイプライン（soft-gate → rate → mask → 生成 →
 * 逆マスク → fail-closed → 監査）。予定/連絡/提出物/おまかせ・text/file 全経路が本関数を共有する
 * （PII/監査の単一不変条件、ADR-036）。`spec` が system/user プロンプト・監査ラベル・パーサ・逆マスク・
 * 検査対象を与える。`source` は監査の区別用。
 */
async function runSectionDraft<T>(
  spec: DraftSpec<T>,
  target: EditorTarget,
  actor: EditorActor,
  text: string,
  opts: { acknowledgePii?: boolean },
  deps: AssistDeps,
  source: "text" | "file",
  flags: { skipRateLimit?: boolean } = {},
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

  // per-school レート制限（プロセス内）。マスク/モデル呼び出しより前に弾く。画像経路は OCR egress を
  // rate で前置済 (draftSectionFromFile) のため二重取得しない（`skipRateLimit`、NFR06）。
  const now = deps.nowMs ?? Date.now();
  if (!flags.skipRateLimit && !(await deps.rateLimiter.tryAcquire(actor.schoolId, now))) {
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
      system: spec.system,
      // 基準日（今日・JST）を渡し、「明日」等の相対表現をモデルが具体的な日付へ変換できるようにする。
      user: spec.buildUser(masked, jstDateLabel(now)),
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
        aiAssist: source === "file" ? `${spec.auditBase}_file` : spec.auditBase,
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

/** テキスト入力 → ドラフト候補（共通: 入力長検証 → 認証 → {@link runSectionDraft}）。 */
async function draftSectionFromText<T>(
  spec: DraftSpec<T>,
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
  return runSectionDraft(spec, auth.target, auth.actor, text, opts, deps, "text");
}

/**
 * ファイル入力 → ドラフト候補（共通: 形式/サイズ検証 → 認証 → テキスト抽出 → {@link runSectionDraft}）。
 * 文書/表 (Word/Excel/CSV) と**テキストレイヤを持つ PDF** は egress なしのローカル抽出。画像 (PNG/JPEG) は
 * 常に、**スキャン PDF（テキストレイヤ希薄）** はフォールバックで Gemini マルチモーダル OCR (ADR-038) に送る。
 * OCR egress が発生し**うる**（画像/PDF）入力には外部委託の三段ガードを適用する: (a) egress の前に per-school
 * rate を取り (NFR06)、(b) 実際に OCR を通したら egress を `audit_log` に記録し (ADR-024 決定2.2)、(c) 抽出
 * テキストは runSectionDraft の PII マスク/soft-gate を通す (ADR-024 決定2.3 / ルール4)。テキスト PDF は OCR を
 * 通らない＝egress なし・監査なし（ocrUsed=false）。
 */
async function draftSectionFromFile<T>(
  spec: DraftSpec<T>,
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
  // MIME allowlist（ファイル名でなく MIME を一次ソース）。レガシー Office 等は弾く。
  const uploadType = resolveUploadType(file.type);
  if (!uploadType || !EDITOR_FILE_EXTS.has(uploadType.ext)) {
    return { ok: false, reason: "unsupported_format" };
  }

  const auth = await authorizeAssist(scope, targetId);
  if (!auth.ok) {
    return auth.result;
  }

  const isImage = IMAGE_FILE_EXTS.has(uploadType.ext);
  // PDF はテキストレイヤがあればローカル抽出（egress なし）、スキャン PDF はテキストレイヤが希薄で Gemini 直送
  // OCR にフォールバックする（egress が発生しうる・ADR-038）。画像は常に OCR egress。
  const isPdf = uploadType.ext === "pdf";
  // 画像 / PDF は OCR egress が発生し**うる**。コスト/越境最小化のため egress の前に per-school rate を取る
  // (NFR06)。取得済ゆえ runSectionDraft 側は再取得しない (skipRateLimit)。docx/xlsx/csv は egress なしの
  // ローカル抽出ゆえ、従来どおり runSectionDraft 側でのみ rate を取る。
  const mightEgress = isImage || isPdf;
  const now = deps.nowMs ?? Date.now();
  if (mightEgress && !(await deps.rateLimiter.tryAcquire(auth.actor.schoolId, now))) {
    return { ok: false, reason: "rate_limited" };
  }

  let text: string;
  let bytes: Uint8Array;
  let ocrUsed = false;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    // 画像 / PDF は OCR クライアントを注入 (ADR-038 Gemini 直送)。PDF はテキストレイヤがあれば OCR を使わず
    // ローカル抽出のまま（フォールバックはスキャン PDF のみ）。docx/xlsx/csv は egress なしのローカル抽出。
    // 抽出テキストは未マスク（ルール4・マスクは runSectionDraft）。
    const extracted = await extractText(
      { bytes, mimeType: file.type, filename: file.name },
      mightEgress ? { ocr: deps.ocr ?? getOcrClient() } : {},
    );
    text = extracted.text.trim().slice(0, ASSIST_INPUT_MAX);
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
    await writeOcrEgressAudit(auth.actor, auth.target, bytes, file.type, text.length);
  }

  if (text.length === 0) {
    return { ok: false, reason: "no_text" };
  }

  return runSectionDraft(spec, auth.target, auth.actor, text, opts, deps, "file", {
    skipRateLimit: mightEgress,
  });
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
  const r = await draftSectionFromText(NOTICE_SPEC, scope, targetId, rawText, opts, deps);
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
  const r = await draftSectionFromText(SCHEDULE_SPEC, scope, targetId, rawText, opts, deps);
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
  const r = await draftSectionFromText(ASSIGNMENT_SPEC, scope, targetId, rawText, opts, deps);
  return r.ok ? { ok: true, assignments: r.items } : r;
}

/**
 * アップロードファイル (PDF / Word / Excel / CSV / 画像) からテキストを抽出し、AI で「連絡」候補に整形して
 * 返す（保存しない）。画像 (PNG/JPEG) は Gemini マルチモーダル OCR (ADR-038)。抽出後は {@link runSectionDraft}
 * を通すので PII マスク/soft-gate/監査は text 経路と同一（ルール4）。画像は OCR egress を別途監査する。
 */
export async function assistDraftNoticesFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssistDraftResult> {
  const r = await draftSectionFromFile(NOTICE_SPEC, scope, targetId, formData, opts, deps);
  return r.ok ? { ok: true, notices: r.items } : r;
}

/** ファイル (PDF/Word/Excel/CSV/画像) から AI で「予定(時間割)」候補に整形して返す（保存しない・画像は OCR/ADR-038）。 */
export async function assistDraftScheduleFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<ScheduleDraftResult> {
  const r = await draftSectionFromFile(SCHEDULE_SPEC, scope, targetId, formData, opts, deps);
  return r.ok ? { ok: true, schedules: r.items } : r;
}

/** ファイル (PDF/Word/Excel/CSV/画像) から AI で「提出物(課題)」候補に整形して返す（保存しない・画像は OCR/ADR-038）。 */
export async function assistDraftAssignmentFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AssignmentDraftResult> {
  const r = await draftSectionFromFile(ASSIGNMENT_SPEC, scope, targetId, formData, opts, deps);
  return r.ok ? { ok: true, assignments: r.items } : r;
}

/**
 * 「おまかせ」: 教員のメモ/発話テキストを AI が予定/連絡/提出物に**分類**して 3 セクション同時に返す
 * （保存しない、ADR-036）。PII マスク/soft-gate/監査は他経路と同一パイプライン（runSectionDraft 共有）。
 */
export async function assistDraftAllAction(
  scope: unknown,
  targetId: unknown,
  rawText: unknown,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AllDraftResult> {
  const r = await draftSectionFromText(ALL_SPEC, scope, targetId, rawText, opts, deps);
  if (!r.ok) {
    return r;
  }
  // ALL_SPEC は束 1 件を返す（parse が [bundle]）。空 3 種は parseAllProposal が null → no_result 済。
  const bundle = r.items[0] ?? { schedules: [], notices: [], assignments: [] };
  return { ok: true, ...bundle };
}

/** 「おまかせ」: ファイル (PDF/Word/Excel/CSV/画像) を AI が予定/連絡/提出物に分類して返す（保存しない・画像 OCR=ADR-038, ADR-036）。 */
export async function assistDraftAllFromFileAction(
  scope: unknown,
  targetId: unknown,
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = defaultDeps(),
): Promise<AllDraftResult> {
  const r = await draftSectionFromFile(ALL_SPEC, scope, targetId, formData, opts, deps);
  if (!r.ok) {
    return r;
  }
  const bundle = r.items[0] ?? { schedules: [], notices: [], assignments: [] };
  return { ok: true, ...bundle };
}
