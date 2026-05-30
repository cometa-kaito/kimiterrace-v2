"use server";

import { publishContent, rollbackContent, unpublishContent, updateContent } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  PUBLISHER_ROLES,
  type UpdateContentInput,
  forbidden,
  invalid,
  isPublishScope,
  isUuid,
  mapDomainError,
  toActor,
} from "./publish-core";

/**
 * F04: 即公開フロー + 安全網の Server Actions (ADR-008 — 画面 mutation は Server Actions)。
 *
 * 教員の「公開」操作 (即公開、承認フローなし) を packages/db のドメインサービス
 * (`publishContent` 等) に橋渡しする薄い層。責務は: 認可 (`requireRole`)、入力検証、
 * actor 解決、エラー → 結果マッピング。RLS context は `withSession` (lib/db.ts) が
 * `withTenantContext` 経由で張る (本モジュールは set_config を手書きしない、ADR-008/ADR-019)。
 *
 * 純粋ロジック・型・定数は `publish-core.ts` に分離している (`"use server"` ファイルは
 * async 関数しか export できない Next の制約のため)。
 */

/** F04: content を即公開する。publisher (school_admin / teacher) のみ。 */
export async function publishContentAction(
  contentId: string,
): Promise<ActionResult<{ publishId: string; version: number }>> {
  if (!isUuid(contentId)) {
    return invalid("contentId が不正です。");
  }
  const user = await requireRole(PUBLISHER_ROLES);
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
  if (input.publishScope !== undefined && !isPublishScope(input.publishScope)) {
    return invalid("publishScope が不正です。");
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length === 0)) {
    return invalid("title が不正です。");
  }
  const user = await requireRole(PUBLISHER_ROLES);
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
  const user = await requireRole(PUBLISHER_ROLES);
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
  const user = await requireRole(PUBLISHER_ROLES);
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
