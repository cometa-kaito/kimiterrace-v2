"use server";

import {
  AiDisabledError,
  type ModelClient,
  type RateLimiter,
  assertAiEnabled,
  createPerSchoolRateLimiter,
  createVertexModelClient,
  findSuspectedPersonalNames,
  findUnmaskedPii,
  maskPII,
  unmaskPII,
} from "@kimiterrace/ai";
import { auditLog } from "@kimiterrace/db";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
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
 * 段C: エディタ AI アシスタント Server Action（連絡ドラフト）。教員のメモ/発話 → AI 整形 →
 * 連絡(notices) の候補を返す（**保存はしない**。client が確認後に既存 `setNoticesAction` で保存する）。
 *
 * 規律:
 * - ルール4 PII: 送信前に書式 PII (電話/メール) を `maskPII` でマスク + `findUnmaskedPii` fail-closed。
 *   氏名らしき高確信パターン (ADR-030 soft-gate) は未 override なら送信せず警告。LLM 呼び出しは
 *   `audit_log` に記録 (本文は残さず件数のみ)。`AI_ENABLED` kill-switch を `assertAiEnabled` で尊重。
 * - ルール2 RLS: 監査書込は `withSession` の自校 tx。actor はセッション由来 (外部入力を信用しない)。
 * - 生メモ/応答本文はログ・監査に出さない。本 action は DB のコンテンツを変更しない (ドラフトのみ)。
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

/**
 * 教員のメモ/発話テキストを AI で「連絡」候補に整形して返す（保存しない）。
 * すべてのエラーを {@link AssistDraftResult} に畳む（throw しない）。
 */
export async function assistDraftNoticesAction(
  scope: unknown,
  targetId: unknown,
  rawText: unknown,
  opts: { acknowledgePii?: boolean } = {},
  deps: AssistDeps = { model: getModel(), rateLimiter: sharedRateLimiter },
): Promise<AssistDraftResult> {
  const target = parseEditorTarget(scope, targetId);
  if (!target) {
    return { ok: false, reason: "error" };
  }
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (text.length > ASSIST_INPUT_MAX) {
    return { ok: false, reason: "too_long" };
  }

  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return { ok: false, reason: "forbidden" };
  }

  // AI_ENABLED kill-switch（#289 / ルール4）。
  try {
    assertAiEnabled();
  } catch (e) {
    if (e instanceof AiDisabledError) {
      return { ok: false, reason: "disabled" };
    }
    throw e;
  }

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
        aiAssist: "notices_draft",
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
