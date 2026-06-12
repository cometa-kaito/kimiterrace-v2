import { type TenantTx, auditLog } from "@kimiterrace/db";
import { headers } from "next/headers";
import type { AuthUser } from "@/lib/auth/session";
import { extractClientMeta } from "@/lib/magic-link/client-meta";

/**
 * UIUX-03: PII を含みうる管理ビューア (events 生ログ / audit_log / ai_chat) の
 * **閲覧操作そのものを `audit_log` に記録する** ヘルパー (CLAUDE.md ルール1 / NFR04)。
 *
 * 「誰が・いつ・どの絞り込みで・何件見たか」を append-only に残し、漏洩時に閲覧範囲を立証できる
 * ようにする。`reports/download-audit.ts` と同じ規律:
 * - `audit_op` enum に read が無いため、**論理 subject (`<viewer>_view_access`) への `insert`** として
 *   記録する (enum / schema 非変更 = ルール3 chokepoint 回避)。
 * - `prev_hash` / `row_hash` は audit_log の BEFORE INSERT トリガ (0003) が計算する → 空文字で渡す。
 * - `actorUserId`: system_admin は users 行ではないため null (FK 制約)。代わりに
 *   **`actorIdentityUid` に IdP uid を必ず載せ、閲覧者を users 行の有無に依らず特定可能にする**
 *   (download-audit との差分・スキーマ上の本来用途)。
 * - `diff` には絞り込み条件・page・件数のみを載せ、**閲覧された行の中身 (PII) は載せない**。
 */

/** 閲覧監査 1 回分の入力。`detail` は絞り込み条件等のメタのみ (PII 禁止)。 */
export type ViewAccessAuditInput = {
  /** 論理 subject。例: "events_view_access" / "audit_log_view_access" / "ai_chat_view_access"。 */
  subject: string;
  /** 学校フィルタが効いている場合はその school_id (横断閲覧は null)。 */
  schoolId?: string | null;
  /** 特定レコード (セッション詳細等) を見た場合はその id。一覧は null。 */
  recordId?: string | null;
  /** 絞り込み条件・page・総件数などのメタ。PII を入れない。 */
  detail: Record<string, unknown>;
};

/**
 * 閲覧監査を 1 行追記する。RLS context を張った tx 内 (withSession) で呼ぶ。
 * IP / UA はリクエストヘッダから取得 (Server Component / Server Action のどちらでも可)。
 */
export async function writeViewAccessAudit(
  tx: TenantTx,
  user: AuthUser,
  input: ViewAccessAuditInput,
): Promise<void> {
  const requestHeaders = await headers();
  const { ip, userAgent } = extractClientMeta(requestHeaders);
  const isSystemAdmin = user.role === "system_admin";
  const actorUserId = isSystemAdmin ? null : user.uid;
  await tx.insert(auditLog).values({
    actorUserId,
    actorIdentityUid: user.uid,
    schoolId: input.schoolId ?? null,
    tableName: input.subject,
    recordId: input.recordId ?? null,
    operation: "insert",
    diff: { action: "view", ...input.detail },
    ipAddress: ip,
    userAgent,
    rowHash: "",
    createdBy: actorUserId,
    updatedBy: actorUserId,
  });
}
