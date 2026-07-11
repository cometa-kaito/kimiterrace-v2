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
} from "@kimiterrace/ai";
import { auditLog, replaceFileImportedEvents } from "@kimiterrace/db";
import { createLogger } from "@kimiterrace/observability";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { hasValidImageMagicBytes, resolveUploadType } from "../teacher-input/upload-validation";
import type {
  CalendarImportEvent,
  CalendarImportSanitizeDropped,
  FiscalYearWindow,
} from "./calendar-import-core";
import { fiscalYearWindow } from "./calendar-import-core";
import {
  type CalendarImportDraftError,
  draftCalendarEventsFromText,
} from "./calendar-import-draft";
import {
  type CalendarImportSaveIssue,
  validateCalendarImportSave,
} from "./calendar-import-save-core";
import { EDITOR_ROLES, type EditorActor, toEditorActor } from "./schedule-core";

/**
 * 年間行事予定表ファイル取込の Server Action（ADR-049 PR-C）。**school 単位**（classId なし）。
 * ファイル → 抽出 → AI 構造化（プレビュー用・保存しない）と、教員確認後の置き換え保存の 2 action。
 *
 * 規律:
 * - ルール4 PII: 生テキストを直接モデルへ渡さず、必ず `draftCalendarEventsFromText`（mask / soft-gate /
 *   fail-closed 内蔵・PR-B）を経由する。OCR egress（画像 / スキャン PDF）は `assistant-actions.ts` の
 *   `draftSectionFromFile` と同じ三段ガード（rate 前置 → egress 監査 → マスク済みパイプライン）。
 *   LLM 呼び出しは `audit_log` に記録（本文は残さず件数のみ）。`AI_ENABLED` kill-switch を尊重。
 * - ルール1/2: 保存は `withSession` のテナント RLS tx 内で `replaceFileImportedEvents`（`file:` 名前空間の
 *   置き換え・packages/db 単一書き込み口）+ `audit_log` 追記を原子化。actor はセッション由来。
 * - ADR-049 決定 4: draft action は**保存しない**。保存は教員がプレビューで確認・修正した後の
 *   `saveCalendarImportAction` のみ（確認なしの自動保存はしない）。
 * - 認可: 教員 + school_admin（`EDITOR_ROLES`・ADR-049 決定「権限 = 教員 + 学校管理者」）。system_admin は
 *   テナント文脈が無く `toEditorActor` が null → forbidden（代行が要件化したら ADR-041 の
 *   schoolId override + tenantScoped 降格で追補する）。
 */

/**
 * 取込で受理する拡張子（ADR-049 文脈 = 年間行事予定表: Excel / CSV / PDF / 画像）。エディタ AI の
 * `EDITOR_FILE_EXTS` から docx を除いた集合（年間表が Word で運用される例が要件に無く、受け口は狭く始める）。
 */
const CALENDAR_IMPORT_FILE_EXTS = new Set(["xlsx", "csv", "pdf", "png", "jpg"]);

/** 画像（OCR 外部委託が発生する）拡張子。egress 前の magic bytes 検査と egress 監査の判定に使う。 */
const IMAGE_FILE_EXTS = new Set(["png", "jpg"]);

/**
 * ファイルサイズ上限 (10MB)。Server Action 経路ゆえ next.config の `serverActions.bodySizeLimit`
 * (12MB) と整合させる（エディタ AI の `ASSIST_FILE_MAX_BYTES` と同値・同根拠）。
 */
const CALENDAR_IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** OCR egress 監査の best-effort 失敗等を構造化記録する（Cloud Logging・本文/PII は出さない）。 */
const importLogger = createLogger("calendar-import");

/**
 * per-school レート制限（プロセス内・エディタ AI と同じ `createPerSchoolRateLimiter` 流儀）。
 * `assistant-actions.ts` の limiter はモジュール私有（"use server" は非 async の export 不可）のため
 * インスタンスは共有できず、本経路は独立トークンで数える（学校あたりの上限は同水準に保たれる）。
 */
const sharedRateLimiter: RateLimiter = createPerSchoolRateLimiter();

let memoModel: ModelClient | null = null;
/** 実 Vertex model を env から遅延生成（assistant-actions と同作法。construct は lazy・generate 時のみ ADC）。 */
function getModel(): ModelClient {
  if (memoModel) return memoModel;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoModel = createVertexModelClient({ project, location });
  return memoModel;
}

let memoOcr: OcrClient | null = null;
/** 画像 OCR クライアント（Gemini 直送・ADR-038）を遅延生成。Vertex と同一 project/location（NFR07）。 */
function getOcrClient(): OcrClient {
  if (memoOcr) return memoOcr;
  const project = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
  const location = process.env.VERTEX_LOCATION ?? "asia-northeast1";
  memoOcr = createGeminiOcrClient({ project, location });
  return memoOcr;
}

/** テスト差し替え用の依存（既定は実 model + プロセス内 rate limiter + 実 OCR。AssistDeps と同形）。 */
export interface CalendarImportActionDeps {
  model: ModelClient;
  rateLimiter: RateLimiter;
  /** 画像/スキャン PDF の OCR クライアント。未指定時のみ実 Gemini OCR を遅延生成（テストはフェイク注入）。 */
  ocr?: OcrClient;
  nowMs?: number;
}

function defaultDeps(): CalendarImportActionDeps {
  return { model: getModel(), rateLimiter: sharedRateLimiter };
}

/** 取込ドラフト action の結果。ok はプレビュー用データ（保存しない）。エラーはすべて reason に畳む。 */
export type CalendarImportDraftActionResult =
  | {
      ok: true;
      events: CalendarImportEvent[];
      dropped: CalendarImportSanitizeDropped & { malformed: number };
      /** 推定に使った年度窓（プレビューの年度明示表示・ADR-049 決定 4）。 */
      window: FiscalYearWindow;
      /** soft-gate 検出数（override 済で送信した場合のプレビュー注意表示・保存監査用）。 */
      suspectedNameCount: number;
      /** 取込元ファイル名（保存時に `raw.fileName` として保全する）。 */
      fileName: string;
    }
  | CalendarImportDraftError
  | {
      ok: false;
      reason:
        | "forbidden"
        | "disabled" // AI_ENABLED OFF
        | "rate_limited"
        | "too_large" // ファイルサイズ上限超過
        | "unsupported_format" // 対応外形式（docx 含む）/ 画像 magic bytes 不整合
        | "extract_failed" // ファイル解析失敗（破損/暗号化等）
        | "no_text"; // テキストを抽出できなかった
    };

/** 認可（教員 + school_admin・自校）+ AI 有効化の共通ゲート（authorizeAssist と同作法・target 解決なし）。 */
async function authorizeCalendarImport(): Promise<
  | { ok: true; actor: EditorActor }
  | { ok: false; result: { ok: false; reason: "forbidden" | "disabled" } }
> {
  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return { ok: false, result: { ok: false, reason: "forbidden" } };
  }
  try {
    assertAiEnabled();
  } catch (e) {
    if (e instanceof AiDisabledError) {
      return { ok: false, result: { ok: false, reason: "disabled" } };
    }
    throw e;
  }
  return { ok: true, actor };
}

/**
 * OCR 外部委託（画像 / スキャン PDF → Vertex Gemini）の監査。`writeOcrEgressAudit`（assistant-actions）と
 * 同じ流儀の school スコープ版（素材本体・抽出本文は残さない = ルール4。egress は発生済ゆえ fail-safe）。
 */
async function writeCalendarImportOcrAudit(
  actor: EditorActor,
  sourceBytes: Uint8Array,
  mediaType: string,
  charCount: number,
): Promise<void> {
  const imageSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  await withSession(async (tx) => {
    await tx.insert(auditLog).values({
      actorUserId: actor.userId,
      schoolId: actor.schoolId,
      tableName: "school_calendar_events",
      recordId: actor.schoolId,
      operation: "update",
      diff: {
        ocrEgress: true,
        backend: "gemini",
        mediaType,
        imageSha256,
        charCount,
        origin: "calendar_import",
      },
      rowHash: "",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
  });
}

/**
 * 年間行事予定表ファイル → AI 構造化イベント（**プレビュー用・保存しない**、ADR-049 決定 4）。
 * throw しない（すべて {@link CalendarImportDraftActionResult} に畳む）。
 *
 * `draftSectionFromFile`（assistant-actions）との差分: (1) 入力を silent truncate せず too_long で失敗させる
 * （年の後半が黙って欠ける方が誤読より悪い・PR-B 方針）、(2) per-school rate は形式を問わず抽出前に 1 回
 * 取得する（画像/PDF の OCR egress 前置と非 egress 経路を単一点に統一。soft-gate 再試行は 2 トークン消費）。
 */
export async function draftCalendarImportAction(
  formData: FormData,
  opts: { acknowledgePii?: boolean } = {},
  deps: CalendarImportActionDeps = defaultDeps(),
): Promise<CalendarImportDraftActionResult> {
  const file = formData?.get?.("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, reason: "empty" };
  }
  if (file.size > CALENDAR_IMPORT_FILE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  // MIME allowlist（ファイル名でなく MIME を一次ソース・upload-validation 単一ソース）。
  const uploadType = resolveUploadType(file.type);
  if (!uploadType || !CALENDAR_IMPORT_FILE_EXTS.has(uploadType.ext)) {
    return { ok: false, reason: "unsupported_format" };
  }

  const auth = await authorizeCalendarImport();
  if (!auth.ok) {
    return auth.result;
  }
  const actor = auth.actor;

  const isImage = IMAGE_FILE_EXTS.has(uploadType.ext);
  // PDF はテキストレイヤがあればローカル抽出（egress なし）、スキャン PDF は Gemini OCR にフォールバック
  // （egress が発生しうる・ADR-038）。画像は常に OCR egress。
  const mightEgress = isImage || uploadType.ext === "pdf";
  const now = deps.nowMs ?? Date.now();
  // per-school rate を egress / モデル呼び出しの前に 1 回だけ取る（NFR06）。
  if (!(await deps.rateLimiter.tryAcquire(actor.schoolId, now))) {
    return { ok: false, reason: "rate_limited" };
  }

  let text: string;
  let bytes: Uint8Array;
  let ocrUsed = false;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    // 画像は **egress の前に** 宣言 MIME と先頭マジックバイトの整合を検査する（偽装バイト列を Vertex に
    // 直送しない = ルール4 の外部委託境界。PDF/xlsx/csv は抽出器パースが fail-close で内容検証する）。
    if (isImage && !hasValidImageMagicBytes(bytes, file.type)) {
      return { ok: false, reason: "unsupported_format" };
    }
    const extracted = await extractText(
      { bytes, mimeType: file.type, filename: file.name },
      mightEgress ? { ocr: deps.ocr ?? getOcrClient() } : {},
    );
    // silent truncate しない（超過は draftCalendarEventsFromText が too_long で失敗させる・PR-B 方針）。
    text = extracted.text.trim();
    ocrUsed = extracted.meta?.ocrUsed === true;
  } catch (e) {
    if (e instanceof UnsupportedFormatError || e instanceof ExtractorNotConfiguredError) {
      return { ok: false, reason: "unsupported_format" };
    }
    if (e instanceof ExtractFailedError) {
      return { ok: false, reason: "extract_failed" };
    }
    return { ok: false, reason: "extract_failed" };
  }

  // OCR egress 監査（実際に OCR を通した時だけ）。egress は上の extract で発生済ゆえ、後続の成否に関わらず
  // 残す（fail-safe）。監査 INSERT が一時 DB 障害で失敗しても本処理は止めず、構造化ログに痕跡を残して
  // degrade する（draftSectionFromFile と同じ設計判断: egress は取り消せない）。
  if (ocrUsed) {
    try {
      await writeCalendarImportOcrAudit(actor, bytes, file.type, text.length);
    } catch (auditError) {
      importLogger.error(
        {
          actorUserId: actor.userId,
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

  // AI 構造化（mask / soft-gate / fail-closed / sanitize 内蔵・PR-B）。生テキストを直接モデルへ渡さない。
  const r = await draftCalendarEventsFromText(text, opts, { model: deps.model, nowMs: deps.nowMs });
  if (!r.ok) {
    return r;
  }

  // ルール1/4: LLM 呼び出しを audit_log に記録（本文は残さず件数・drop 内訳のみ）。
  await withSession(async (tx) => {
    await tx.insert(auditLog).values({
      actorUserId: actor.userId,
      schoolId: actor.schoolId,
      tableName: "school_calendar_events",
      recordId: actor.schoolId,
      operation: "update",
      diff: {
        aiAssist: "calendar_import_draft_file",
        eventCount: r.events.length,
        dropped: r.dropped,
        suspectedNameCount: r.suspectedNameCount,
        fiscalYear: r.window.fiscalYear,
      },
      rowHash: "",
      createdBy: actor.userId,
      updatedBy: actor.userId,
    });
  });

  return {
    ok: true,
    events: r.events,
    dropped: r.dropped,
    window: r.window,
    suspectedNameCount: r.suspectedNameCount,
    fileName: file.name,
  };
}

/** 保存 action に添える取込メタ（クライアント申告・監査の参考情報。検証してから記録する）。 */
export type CalendarImportSaveMeta = {
  fileName?: unknown;
  dropped?: unknown;
  suspectedNameCount?: unknown;
};

/** 保存 action の結果。invalid は行番号付きの検証エラー（プレビューで直して再保存する）。 */
export type CalendarImportSaveResult =
  | { ok: true; deleted: number; inserted: number }
  | { ok: false; reason: "invalid"; issues: CalendarImportSaveIssue[] }
  | { ok: false; reason: "forbidden" | "error" };

/** 監査 diff に載せてよい dropped キー（クライアント申告値の allowlist。未知キーは捨てる）。 */
const DROPPED_META_KEYS = [
  "invalidDate",
  "outOfWindow",
  "duplicates",
  "overCap",
  "endDateStripped",
  "malformed",
] as const;

/** ファイル名の監査/raw 格納向けクランプ長（表示・追跡に十分な長さ。パスは含まれない前提）。 */
const FILE_NAME_MAX = 200;

/** クライアント申告メタを検証・クランプする（監査 diff / raw.fileName に**未検証の外部入力**を入れない）。 */
function sanitizeSaveMeta(raw: unknown): {
  fileName: string;
  dropped: Record<string, number>;
  suspectedNameCount: number;
} {
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fileName =
    typeof obj.fileName === "string" && obj.fileName.trim().length > 0
      ? obj.fileName.trim().slice(0, FILE_NAME_MAX)
      : "(不明なファイル)";
  const droppedIn =
    obj.dropped !== null && typeof obj.dropped === "object" && !Array.isArray(obj.dropped)
      ? (obj.dropped as Record<string, unknown>)
      : {};
  const dropped: Record<string, number> = {};
  for (const key of DROPPED_META_KEYS) {
    const v = droppedIn[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      dropped[key] = v;
    }
  }
  const suspectedNameCount =
    typeof obj.suspectedNameCount === "number" &&
    Number.isFinite(obj.suspectedNameCount) &&
    obj.suspectedNameCount >= 0
      ? obj.suspectedNameCount
      : 0;
  return { fileName, dropped, suspectedNameCount };
}

/**
 * プレビューで教員が確認・修正した行事一覧を**置き換え保存**する（ADR-049 決定 1/4/6）。
 *
 * 再検証（`validateCalendarImportSave`・クライアントの編集済み配列を信用しない）→ テナント RLS tx 内で
 * `replaceFileImportedEvents`（前回の `file:` 名前空間を丸ごと削除して新バッチ INSERT）+ `audit_log` 追記。
 * 検証エラーは切り詰め・自動修正せず行番号付きで返す（教員が直してから保存し直す）。
 */
export async function saveCalendarImportAction(
  rawEvents: unknown,
  rawMeta: CalendarImportSaveMeta = {},
  deps: { nowMs?: number } = {},
): Promise<CalendarImportSaveResult> {
  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return { ok: false, reason: "forbidden" };
  }

  const window = fiscalYearWindow(deps.nowMs ?? Date.now());
  const validated = validateCalendarImportSave(rawEvents, window);
  if (!validated.ok) {
    return { ok: false, reason: "invalid", issues: validated.issues };
  }

  const meta = sanitizeSaveMeta(rawMeta);
  const batchId = crypto.randomUUID();
  try {
    const saved = await withSession(async (tx) => {
      // 置き換え + 監査を同一 tx で原子化（片方だけ残さない）。書き込み口は packages/db ヘルパに単一化
      // （ADR-049 残存リスク④・`source_id IS NULL AND uid LIKE 'file:%'` の境界はヘルパが強制）。
      const result = await replaceFileImportedEvents(tx, {
        schoolId: actor.schoolId,
        batchId,
        fileName: meta.fileName,
        actorUserId: actor.userId,
        events: validated.events.map((ev) => ({
          summary: ev.summary,
          startDate: ev.startDate,
          endDate: ev.endDate ?? null,
          startAt: null,
          endAt: null,
          allDay: ev.allDay,
          location: ev.location ?? null,
        })),
      });
      // ルール1: 置き換え結果 + 取込時の drop 内訳 / soft-gate 検出数（クライアント申告・allowlist 済）を記録。
      await tx.insert(auditLog).values({
        actorUserId: actor.userId,
        schoolId: actor.schoolId,
        tableName: "school_calendar_events",
        recordId: actor.schoolId,
        operation: "update",
        diff: {
          calendarFileImport: true,
          batchId,
          fileName: meta.fileName,
          deleted: result.deleted,
          inserted: result.inserted,
          dropped: meta.dropped,
          suspectedNameCount: meta.suspectedNameCount,
          fiscalYear: window.fiscalYear,
        },
        rowHash: "",
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      return result;
    });
    // 取込ページの「前回の取込」概況を即時反映（エディタ側の消費 = PR-D は自前のデータ読みで追従する）。
    revalidatePath("/app/editor/calendar-import");
    return { ok: true, deleted: saved.deleted, inserted: saved.inserted };
  } catch (error) {
    // DB 障害等。本文/イベント内容はログに出さない（件数もエラー時は不確定なので残さない）。
    importLogger.error(
      {
        actorUserId: actor.userId,
        schoolId: actor.schoolId,
        batchId,
        error: error instanceof Error ? error.message : String(error),
      },
      "calendar import save failed",
    );
    return { ok: false, reason: "error" };
  }
}
