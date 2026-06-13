"use server";

import { findSuspectedPersonalNames } from "@kimiterrace/ai";
import {
  type DeniedPublishAction,
  type PublishActor,
  type TenantTx,
  auditLog,
  createContent,
  getContentDetail,
  publishContent,
  recordPublishDenial,
  rollbackContent,
  unpublishContent,
  updateContent,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRoleAllowed, requireUser } from "../auth/guard";
import type { AuthUser } from "../auth/session";
import { withSession, withUserSession } from "../db";
import {
  type ActionResult,
  type CreateContentInput,
  PUBLISHER_ROLES,
  type PublishScopeValue,
  type UpdateContentInput,
  forbidden,
  invalid,
  isUuid,
  mapDomainError,
  piiWarning,
  toActor,
  validateCreateInput,
  validateUpdateInput,
} from "./publish-core";

/**
 * F04: 即公開フロー + 安全網の Server Actions (ADR-008 — 画面 mutation は Server Actions)。
 *
 * 教員の「公開」操作 (即公開、承認フローなし) を packages/db のドメインサービス
 * (`publishContent` 等) に橋渡しする薄い層。責務は: 認可 (`authorizePublisher`)、入力検証、
 * actor 解決、エラー → 結果マッピング。RLS context は `withSession` (lib/db.ts) が
 * `withTenantContext` 経由で張る (本モジュールは set_config を手書きしない、ADR-008/ADR-019)。
 *
 * 純粋ロジック・型・定数は `publish-core.ts` に分離している (`"use server"` ファイルは
 * async 関数しか export できない Next の制約のため)。
 */

/**
 * 公開系 Server Action 共通の認可ゲート。従来の `requireRole(PUBLISHER_ROLES)` を内製化し、
 * 認可拒否を audit_log に記録する余地を挟む (NFR04 不正検知、Issue #150 L-2)。
 *
 * - 未認証 → `/login` に redirect (`requireUser`、従来どおり)。
 * - publisher (school_admin。teacher は finding⑧ で除外) → 認可済み `AuthUser` を返す。
 * - それ以外の role (student / guardian / system_admin 等) → **認可拒否**: 拒否試行を
 *   best-effort で監査記録した上で `/forbidden` に redirect する。**本番の UX は従来 requireRole と
 *   同一** (role 不足 → /forbidden)。差分は「拒否を監査に残す」点のみ。
 *
 * 監査に残せない拒否 (設計上の限界、いずれも tenant-scoped audit_log に書けない):
 * - schoolId を持たない actor (system_admin / 異常) — テナント RLS context を張れない。
 * - 認証前の入力エラー (invalid_input) — session が無い (各 action が requireUser より前に弾く)。
 */
async function authorizePublisher(
  action: DeniedPublishAction,
  contentId: string,
): Promise<AuthUser> {
  const user = await requireUser();
  if (isRoleAllowed(user.role, PUBLISHER_ROLES)) {
    return user;
  }
  await recordDenialBestEffort(user, action, contentId);
  redirect("/forbidden");
}

/**
 * 認可拒否を audit_log に **ベストエフォート**で記録する。記録の失敗 (DB 一時障害等) で拒否応答
 * (/forbidden) を妨げない。actor は拒否されたユーザー本人で、`withUserSession` が同じ user で tenant tx を
 * 張るため audit_log_insert policy (actor_user_id = app.current_user_id、migration 0005) を充足する。
 * schoolId を持たない actor は tenant-scoped audit_log に書けないため記録対象外 (redirect のみ)。
 *
 * `requireUser()` で解決済みの `user` を `withUserSession` に渡し、cookie の再検証 (失効チェックの
 * Identity Platform 往復) を二重に走らせない。拒否試行は敵対的経路なので IdP 往復を最小化する。
 */
async function recordDenialBestEffort(
  user: AuthUser,
  action: DeniedPublishAction,
  contentId: string,
): Promise<void> {
  if (!user.schoolId) {
    return;
  }
  const actor = { userId: user.uid, schoolId: user.schoolId };
  try {
    await withUserSession(user, (tx) =>
      recordPublishDenial(tx, actor, { action, contentId, attemptedRole: user.role }),
    );
  } catch {
    // 監査記録の失敗で拒否応答を妨げない。記録は best-effort。
  }
}

/**
 * content-scoped 監査記録 (ルール1)。`schedule-actions.ts` の writeAudit と同型で、本モジュール固有の
 * 用途 (PII override の立証) に用いる。`recordPublishDenial` (packages/db) とは別経路: 同一 publish tx
 * 内で append し、override と公開を原子化する。prev_hash / row_hash は BEFORE INSERT トリガ (0003) が計算。
 */
async function writeContentAudit(
  tx: TenantTx,
  actor: PublishActor,
  params: { recordId: string; operation: "insert" | "update"; diff: unknown },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "contents",
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/**
 * F04: content を即公開する。publisher (school_admin のみ・teacher は finding⑧ で除外)。
 *
 * **ADR-030 (#426) authoring soft-gate**: 公開対象本文に氏名らしき高確信パターン (敬称連接、
 * `findSuspectedPersonalNames`) を検出したら、**hard-block せず** `pii_warning` を返して投稿者の明示
 * override を促す (FP で正当な掲示を阻害しないため、warn + override + 監査)。`acknowledgePii` が true の
 * ときのみ公開を実行し、override を `audit_log` に記録する (NFR04: 誰が PII 含有を承知で公開したかを立証)。
 * 監査 diff は **件数のみ** で生の疑わしい氏名を複製しない (ルール4: PII を audit_log に焼き込まない)。
 * 本 gate は embedding バッチの fail-closed (`findUnmaskedPii`) の上流の追加層 (多層防御)。
 */
export async function publishContentAction(
  contentId: string,
  opts?: { acknowledgePii?: boolean },
): Promise<ActionResult<{ publishId: string; version: number }>> {
  if (!isUuid(contentId)) {
    return invalid("contentId が不正です。");
  }
  const user = await authorizePublisher("publish", contentId);
  const actor = toActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは公開できません。");
  }
  try {
    const outcome = await withSession(
      async (tx): Promise<ActionResult<{ publishId: string; version: number }>> => {
        // 公開対象本文を RLS 下で取得 (不可視/不存在は not_found)。氏名らしき高確信パターンを走査。
        const detail = await getContentDetail(tx, contentId);
        if (!detail) {
          return { ok: false, code: "not_found", message: "コンテンツが見つかりません。" };
        }
        const suspects = findSuspectedPersonalNames(detail.content.body);
        // 検出あり & 未 override → warn のみ (公開しない)。投稿者へ疑わしい表層を提示。
        if (suspects.length > 0 && !opts?.acknowledgePii) {
          return piiWarning(suspects.map((s) => s.surface));
        }
        const result = await publishContent(tx, actor, contentId);
        // override 公開時のみ監査 (件数だけ、生氏名は audit に複製しない)。公開と同一 tx で原子化。
        if (suspects.length > 0) {
          await writeContentAudit(tx, actor, {
            recordId: contentId,
            operation: "update",
            diff: { piiOverride: true, suspectedNameCount: suspects.length },
          });
        }
        return { ok: true, data: { publishId: result.publishId, version: result.version } };
      },
    );
    // 公開成功時のみ再検証 (warn / not_found では掲示状態は不変)。
    if (outcome.ok) {
      revalidatePath("/admin/editor");
      revalidatePath("/admin/contents");
      revalidatePath("/");
    }
    return outcome;
  } catch (error) {
    return mapDomainError(error);
  }
}

/**
 * F01/F02 (#509 S3a): content を draft で新規作成する。publisher (school_admin のみ・teacher は finding⑧ で除外)。
 *
 * 教員入力 (ファイル / 音声・チャット) の抽出結果を「編集してから公開」する下書きの受け皿。
 * 作成後に呼出側が `/admin/contents/{contentId}` へ誘導し、既存エディタで編集 → `publishContentAction` で公開する。
 * 未認証は /login、publisher 以外は /forbidden (`requireUser` + role gate)。新規作成のため contentId が
 * まだ無く拒否監査 (recordPublishDenial) は対象外。
 */
export async function createContentAction(
  input: CreateContentInput,
): Promise<ActionResult<{ contentId: string; version: number }>> {
  const invalidInput = validateCreateInput(input);
  if (invalidInput) {
    return invalidInput;
  }
  const user = await requireUser();
  if (!isRoleAllowed(user.role, PUBLISHER_ROLES)) {
    redirect("/forbidden");
  }
  const actor = toActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーはコンテンツを作成できません。");
  }
  try {
    const result = await withSession((tx) =>
      createContent(tx, actor, {
        title: input.title,
        body: input.body ?? "",
        // validateCreateInput が enum 値であることを保証済み (ルール3: DB enum が最終強制)。
        publishScope: input.publishScope as PublishScopeValue,
        targets: input.targets,
      }),
    );
    revalidatePath("/admin/contents");
    return { ok: true, data: { contentId: result.id, version: result.version } };
  } catch (error) {
    return mapDomainError(error);
  }
}

/** F04: content を更新し新バージョンを追記する (公開状態は変えない)。 */
export async function updateContentAction(
  contentId: string,
  input: UpdateContentInput,
): Promise<ActionResult<{ version: number }>> {
  if (!isUuid(contentId)) {
    return invalid("contentId が不正です。");
  }
  const invalidInput = validateUpdateInput(input);
  if (invalidInput) {
    return invalidInput;
  }
  const user = await authorizePublisher("update", contentId);
  const actor = toActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは編集できません。");
  }
  try {
    const result = await withSession((tx) =>
      updateContent(tx, actor, contentId, {
        title: input.title,
        body: input.body,
        publishScope: input.publishScope,
        targets: input.targets,
      }),
    );
    revalidatePath("/admin/editor");
    return { ok: true, data: { version: result.version } };
  } catch (error) {
    return mapDomainError(error);
  }
}

/** F04: content を非公開化する。 */
export async function unpublishContentAction(
  contentId: string,
): Promise<ActionResult<{ publishId: string }>> {
  if (!isUuid(contentId)) {
    return invalid("contentId が不正です。");
  }
  const user = await authorizePublisher("unpublish", contentId);
  const actor = toActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは操作できません。");
  }
  try {
    const result = await withSession((tx) => unpublishContent(tx, actor, contentId));
    revalidatePath("/admin/editor");
    revalidatePath("/");
    return { ok: true, data: { publishId: result.publishId } };
  } catch (error) {
    return mapDomainError(error);
  }
}

/** F04.2: 1-click rollback。指定バージョンの本文を復元し、新バージョンとして積む。 */
export async function rollbackContentAction(
  contentId: string,
  targetVersion: number,
): Promise<ActionResult<{ version: number; restoredFrom: number }>> {
  if (!isUuid(contentId)) {
    return invalid("contentId が不正です。");
  }
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return invalid("targetVersion が不正です。");
  }
  const user = await authorizePublisher("rollback", contentId);
  const actor = toActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは操作できません。");
  }
  try {
    const result = await withSession((tx) => rollbackContent(tx, actor, contentId, targetVersion));
    revalidatePath("/admin/editor");
    revalidatePath("/");
    return { ok: true, data: { version: result.version, restoredFrom: result.restoredFrom } };
  } catch (error) {
    return mapDomainError(error);
  }
}
