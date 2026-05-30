import { and, desc, eq, sql } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { teacherInputAttachments } from "../schema/teacher-input-attachments.js";
import { teacherInputs } from "../schema/teacher-inputs.js";

/**
 * F02: 教員音声 / チャット入力ドメインサービス。
 *
 * すべて呼出側で `withTenantContext` / `withSession` 済みの `tx` を受け取り、RLS 前提で動く。
 * RLS が school 越境を DB レベルで拒否する (ADR-019 / CLAUDE.md ルール2) ため、各関数は
 * 渡された `schoolId` (= 認証コンテキストの school) を信頼して INSERT/絞り込みに使う。
 *
 * **監査 (CLAUDE.md ルール1)**: すべての mutation で audit_log に 1 行記録する。
 * diff は {before, after} 形式 (NFR04)。
 *
 * **PII (CLAUDE.md ルール4)**: transcript は PII を含みうるが、本スライスでは Vertex AI 送信が
 * 無いため保存時 RLS + 監査で担保する。F03 連携 (submit 後の構造化) 時のマスキングは別 PR。
 *
 * 関連: F02 (docs/requirements/functional/F02-teacher-voice-chat-input.md), ADR-005/006/019
 */

export type InputType = "voice" | "chat";
export type InputStatus = "draft" | "transcribing" | "ready" | "submitted";

type AuditParams = {
  schoolId: string;
  actorUserId: string | null;
  tableName: string;
  recordId: string;
  operation: "insert" | "update" | "delete";
  diff: unknown;
};

async function recordAudit(tx: TenantTx, params: AuditParams): Promise<void> {
  await tx.insert(auditLog).values({
    schoolId: params.schoolId,
    actorUserId: params.actorUserId,
    tableName: params.tableName,
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as never,
    // row_hash は NFR04 の hash chain トリガ (migrations/0003_audit_trigger.sql) が
    // BEFORE INSERT で必ず上書き計算する。クライアント入力値は無視されるため、
    // notNull 制約を満たすためのプレースホルダ "" を渡す (改竄入力対策はトリガ側)。
    rowHash: "",
  });
}

export type CreateTeacherInputInput = {
  inputType: InputType;
  /** チャット本文 or 文字起こし済みテキスト。voice の文字起こし待ちドラフトでは省略可。 */
  transcript?: string | null;
  /** 音声入力時の Cloud Storage 参照 (任意)。 */
  audioPath?: string | null;
  /**
   * 初期ステータス。省略時は chat=draft / voice=transcribing。
   * TODO(音声): voice の文字起こしジョブ起動は別 PR。ここでは status の置き場のみ。
   */
  status?: InputStatus;
};

/**
 * 教員入力を作成する (chat ドラフト / voice 文字起こし待ちドラフト)。
 */
export async function createTeacherInput(
  tx: TenantTx,
  schoolId: string,
  actorUserId: string,
  input: CreateTeacherInputInput,
) {
  const status: InputStatus =
    input.status ?? (input.inputType === "voice" ? "transcribing" : "draft");
  const [row] = await tx
    .insert(teacherInputs)
    .values({
      schoolId,
      teacherId: actorUserId,
      inputType: input.inputType,
      status,
      transcript: input.transcript ?? null,
      audioPath: input.audioPath ?? null,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    })
    .returning();
  // RLS WITH CHECK 違反等で INSERT が 0 行を返した場合は明示エラー (sliently 握りつぶさない)。
  if (!row) {
    throw new Error("createTeacherInput: INSERT が行を返しませんでした (RLS 拒否の可能性)");
  }
  await recordAudit(tx, {
    schoolId,
    actorUserId,
    tableName: "teacher_inputs",
    recordId: row.id,
    operation: "insert",
    diff: { after: row },
  });
  return row;
}

/**
 * FR-08: 教員入力の履歴一覧 (新しい順)。RLS により自校分のみ返る。
 */
export async function listTeacherInputs(tx: TenantTx) {
  return await tx.select().from(teacherInputs).orderBy(desc(teacherInputs.createdAt));
}

/**
 * 入力の詳細を取得する。RLS により他校 id は 0 件 → null。
 */
export async function getTeacherInput(tx: TenantTx, id: string) {
  const [row] = await tx.select().from(teacherInputs).where(eq(teacherInputs.id, id)).limit(1);
  return row ?? null;
}

export type UpdateTranscriptInput = {
  transcript: string;
};

/**
 * FR-04: transcript を編集する。transcript_edited=true をセットし、ステータスが
 * transcribing なら ready に進める (文字起こし結果を人が確定したとみなす)。
 *
 * @returns 更新後の行。対象が無い (他校 / 不在) 場合は null。
 */
export async function updateTranscript(
  tx: TenantTx,
  actorUserId: string,
  id: string,
  input: UpdateTranscriptInput,
) {
  const before = await getTeacherInput(tx, id);
  if (!before) return null;

  const [row] = await tx
    .update(teacherInputs)
    .set({
      transcript: input.transcript,
      transcriptEdited: true,
      status: before.status === "transcribing" ? "ready" : before.status,
      updatedAt: sql`now()`,
      updatedBy: actorUserId,
    })
    .where(eq(teacherInputs.id, id))
    .returning();
  if (!row) return null;

  await recordAudit(tx, {
    schoolId: row.schoolId,
    actorUserId,
    tableName: "teacher_inputs",
    recordId: row.id,
    operation: "update",
    diff: { before, after: row },
  });
  return row;
}

export type SaveDraftInput = {
  transcript?: string | null;
  audioPath?: string | null;
};

/**
 * FR-06: 下書き保存。transcript / audio_path を更新し status=draft に戻す。
 * (submitted な入力は draft に戻さない: 二重送信防止のため null を返す)
 *
 * @returns 更新後の行。対象が無い / 既に submitted の場合は null。
 */
export async function saveDraft(
  tx: TenantTx,
  actorUserId: string,
  id: string,
  input: SaveDraftInput,
) {
  const before = await getTeacherInput(tx, id);
  if (!before || before.status === "submitted") return null;

  const [row] = await tx
    .update(teacherInputs)
    .set({
      transcript: input.transcript ?? before.transcript,
      audioPath: input.audioPath ?? before.audioPath,
      status: "draft",
      updatedAt: sql`now()`,
      updatedBy: actorUserId,
    })
    .where(eq(teacherInputs.id, id))
    .returning();
  if (!row) return null;

  await recordAudit(tx, {
    schoolId: row.schoolId,
    actorUserId,
    tableName: "teacher_inputs",
    recordId: row.id,
    operation: "update",
    diff: { before, after: row },
  });
  return row;
}

/**
 * FR-07: F03 へ送信する。status=submitted + submitted_at=now() をセットする。
 *
 * 冪等性: 既に submitted の場合はそのまま返す (二重 submit を許容しつつ submitted_at は維持)。
 *
 * TODO(F03 連携): submit を契機に PII マスキング → Vertex AI 構造化 (ai_extractions 生成) を
 *   起動する経路は別 PR。本関数は状態遷移のみを担い、AI 呼び出しは行わない。
 *
 * @returns 更新後の行。対象が無い場合は null。送信可能な transcript が無い場合は throw。
 */
export async function submitTeacherInput(tx: TenantTx, actorUserId: string, id: string) {
  const before = await getTeacherInput(tx, id);
  if (!before) return null;
  if (before.status === "submitted") return before;
  if (!before.transcript || before.transcript.trim().length === 0) {
    throw new TeacherInputValidationError("transcript が空のため送信できません (FR-07)。");
  }

  const [row] = await tx
    .update(teacherInputs)
    .set({
      status: "submitted",
      submittedAt: sql`now()`,
      updatedAt: sql`now()`,
      updatedBy: actorUserId,
    })
    .where(eq(teacherInputs.id, id))
    .returning();
  if (!row) return null;

  await recordAudit(tx, {
    schoolId: row.schoolId,
    actorUserId,
    tableName: "teacher_inputs",
    recordId: row.id,
    operation: "update",
    diff: { before, after: row },
  });
  return row;
}

/**
 * 入力を削除する。添付メタは FK cascade で同時に消える。
 *
 * @returns 削除できたら true、対象が無ければ false。
 */
export async function deleteTeacherInput(
  tx: TenantTx,
  actorUserId: string,
  id: string,
): Promise<boolean> {
  const before = await getTeacherInput(tx, id);
  if (!before) return false;

  const res = await tx.delete(teacherInputs).where(eq(teacherInputs.id, id)).returning();
  if (res.length === 0) return false;

  await recordAudit(tx, {
    schoolId: before.schoolId,
    actorUserId,
    tableName: "teacher_inputs",
    recordId: id,
    operation: "delete",
    diff: { before },
  });
  return true;
}

export type AddAttachmentInput = {
  storagePath: string;
  mimeType: string;
};

/**
 * FR-05 (メタ行のみ): 入力に添付メタを登録する。
 *
 * **スコープ**: クライアントが別経路で Cloud Storage にアップロード済みの object の
 * `storage_path` を受け取り、メタ行を作るだけ。署名付き URL 発行・実アップロードは別 PR。
 *
 * @returns 作成した添付メタ。親 input が無い (他校 / 不在) 場合は null。
 */
export async function addAttachment(
  tx: TenantTx,
  actorUserId: string,
  inputId: string,
  input: AddAttachmentInput,
) {
  const parent = await getTeacherInput(tx, inputId);
  if (!parent) return null;

  const [row] = await tx
    .insert(teacherInputAttachments)
    .values({
      schoolId: parent.schoolId,
      inputId,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    })
    .returning();
  if (!row) {
    throw new Error("addAttachment: INSERT が行を返しませんでした (RLS 拒否の可能性)");
  }

  await recordAudit(tx, {
    schoolId: parent.schoolId,
    actorUserId,
    tableName: "teacher_input_attachments",
    recordId: row.id,
    operation: "insert",
    diff: { after: row },
  });
  return row;
}

/** 入力に紐づく添付メタ一覧 (新しい順)。 */
export async function listAttachments(tx: TenantTx, inputId: string) {
  return await tx
    .select()
    .from(teacherInputAttachments)
    .where(and(eq(teacherInputAttachments.inputId, inputId)))
    .orderBy(desc(teacherInputAttachments.createdAt));
}

/** ドメイン層のバリデーション失敗。Route 層が 422 に変換する。 */
export class TeacherInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeacherInputValidationError";
  }
}
