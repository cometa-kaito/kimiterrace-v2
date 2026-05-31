"use server";

import {
  type DeniedPublishAction,
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
import { withSession } from "../db";
import {
  type ActionResult,
  PUBLISHER_ROLES,
  type UpdateContentInput,
  forbidden,
  invalid,
  isUuid,
  mapDomainError,
  toActor,
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
 * - publisher (school_admin / teacher) → 認可済み `AuthUser` を返す。
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
 * (/forbidden) を妨げない。actor は拒否されたユーザー本人で、`withSession` が同じ user で tenant tx を
 * 張るため audit_log_insert policy (actor_user_id = app.current_user_id、migration 0005) を充足する。
 * schoolId を持たない actor は tenant-scoped audit_log に書けないため記録対象外 (redirect のみ)。
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
    await withSession((tx) =>
      recordPublishDenial(tx, actor, { action, contentId, attemptedRole: user.role }),
    );
  } catch {
    // 監査記録の失敗で拒否応答を妨げない。記録は best-effort。
  }
}

/** F04: content を即公開する。publisher (school_admin / teacher) のみ。 */
export async function publishContentAction(
  contentId: string,
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
    const result = await withSession((tx) => publishContent(tx, actor, contentId));
    revalidatePath("/admin/editor");
    revalidatePath("/");
    return { ok: true, data: { publishId: result.publishId, version: result.version } };
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
