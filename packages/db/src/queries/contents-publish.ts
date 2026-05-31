import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { auditLog } from "../schema/audit-log.js";
import { contentVersions } from "../schema/content-versions.js";
import { contents } from "../schema/contents.js";
import { publishes } from "../schema/publishes.js";

/**
 * F04: 即公開フロー + 安全網のドメインサービス。
 *
 * 「教員が公開を押すと承認なしで即公開、代わりに 4 種の安全網で事後対応可能にする」
 * (docs/requirements/functional/F04-instant-publish-safety-nets.md) のサーバー側中核。
 *
 * 本モジュールは **RLS コンテキストを張ったトランザクション内で呼ぶ** 前提で、`TenantTx` を
 * 受け取る純粋なドメイン関数群として実装する (auth/cookie 層には依存しない)。呼び出し側
 * (apps/web の Route Handler / Server Action) が `withSession(tx => publishContent(tx, ...))`
 * のように RLS context (ADR-019) を確立してから呼ぶ。
 *
 * ## 安全網との対応
 * - **F04.1 audit_log**: publish / update / unpublish / rollback を全件 `audit_log` に追記する。
 *   audit_log は append-only + hash chain (migration 0003) で改竄検知可能。
 * - **F04.2 1-click rollback**: 変更のたびに `content_versions` に全バージョンを保管し、rollback も
 *   履歴を消さず **新バージョンとして追記** する。
 * - **F04.4 公開先明示**: `contents.publish_scope` は NOT NULL。曖昧な「全校」を避け、呼び出し側が
 *   明示選択した値をそのまま保持する (本サービスは scope を改変しない)。
 *
 * ## 監査の前提条件 (RLS / NFR04)
 * `audit_log_insert` policy (migration 0002 / 0005) は、テナント内ロールでは
 * `actor_user_id = current_setting('app.current_user_id')` を強制する。したがって本サービスは
 * audit 行の `actor_user_id` に **必ず現在のユーザー** (`actor.userId`) を載せる。詐称・NULL は
 * policy で拒否される (Issue #100 / #105)。
 */

/** 公開操作の実行者。`userId` は audit/監査カラム、`schoolId` は RLS WITH CHECK 充足に使う。 */
export type PublishActor = {
  userId: string;
  schoolId: string;
};

/** content 行のうちバージョン snapshot に保存するフィールド (rollback で復元する対象)。 */
type ContentSnapshot = {
  title: string;
  body: string;
  publishScope: string;
  status: string;
  targets: unknown;
};

/** 公開対象 content をスナップショットに落とす。rollback はこの形を contents に復元する。 */
function toSnapshot(row: {
  title: string;
  body: string;
  publishScope: string;
  status: string;
  targets: unknown;
}): ContentSnapshot {
  return {
    title: row.title,
    body: row.body,
    publishScope: row.publishScope,
    status: row.status,
    targets: row.targets,
  };
}

/**
 * RLS スコープで content を 1 件取得し、**行を FOR UPDATE でロック**する。
 * 見つからない (= 別テナント / 不存在) なら throw。
 *
 * 全 mutation (publish / update / unpublish / rollback) はこの関数を入口に呼ぶ。content 行を
 * ロックすることで同一 content への同時書き込みを直列化し、`content_versions` のバージョン採番
 * (max+1) レースと多重 active publish レースをアプリ層で防ぐ (#145)。DB レベルの UNIQUE 制約
 * (ux_content_versions_content_version / ux_publishes_active_per_content) は最終防壁。
 */
async function loadContentOrThrow(tx: TenantTx, contentId: string) {
  const [row] = await tx
    .select({
      id: contents.id,
      schoolId: contents.schoolId,
      title: contents.title,
      body: contents.body,
      publishScope: contents.publishScope,
      status: contents.status,
      targets: contents.targets,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1)
    .for("update");
  if (!row) {
    throw new ContentNotFoundError(contentId);
  }
  return row;
}

/** 指定 content の次バージョン番号 (現状 max + 1、初回は 1)。 */
async function nextVersionNumber(tx: TenantTx, contentId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${contentVersions.version})` })
    .from(contentVersions)
    .where(eq(contentVersions.contentId, contentId));
  return (row?.max ?? 0) + 1;
}

/** content の最新バージョンを取得 (なければ null)。 */
async function latestVersion(tx: TenantTx, contentId: string) {
  const [row] = await tx
    .select({ id: contentVersions.id, version: contentVersions.version })
    .from(contentVersions)
    .where(eq(contentVersions.contentId, contentId))
    .orderBy(desc(contentVersions.version))
    .limit(1);
  return row ?? null;
}

/** 新しい content_versions 行を追記し、その id / version を返す。 */
async function insertVersion(
  tx: TenantTx,
  actor: PublishActor,
  contentId: string,
  snapshot: ContentSnapshot,
  diffSummary: string | null,
): Promise<{ id: string; version: number }> {
  const version = await nextVersionNumber(tx, contentId);
  const [row] = await tx
    .insert(contentVersions)
    .values({
      schoolId: actor.schoolId,
      contentId,
      version,
      snapshot,
      diffSummary,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning({ id: contentVersions.id, version: contentVersions.version });
  if (!row) {
    throw new Error("content_versions の追記に失敗しました (returning が空)");
  }
  return row;
}

/**
 * audit_log に 1 行追記する (F04.1)。prev_hash / row_hash は BEFORE INSERT トリガが計算するため
 * ここでは渡さない。`actor_user_id` は RLS policy 充足のため必ず actor.userId を載せる。
 */
async function writeAudit(
  tx: TenantTx,
  actor: PublishActor,
  params: {
    tableName: string;
    recordId: string;
    operation: "insert" | "update" | "delete";
    diff: unknown;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: params.tableName,
    recordId: params.recordId,
    operation: params.operation,
    diff: params.diff as object,
    // prev_hash / row_hash は audit_log の BEFORE INSERT トリガ (migration 0003) が
    // 入力値を無条件に上書きして計算する。row_hash は NOT NULL のため placeholder を渡すが、
    // トリガが必ず SHA-256 hex で再設定する (改竄入力対策も兼ねる)。
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/** content が存在しない / 別テナントで不可視のときに投げる。呼び出し側は 404 に変換する。 */
export class ContentNotFoundError extends Error {
  constructor(contentId: string) {
    super(`content が見つかりません (不存在 / 別テナント): ${contentId}`);
    this.name = "ContentNotFoundError";
  }
}

/** 公開中の publish が無い content を unpublish しようとしたときに投げる。 */
export class NoActivePublishError extends Error {
  constructor(contentId: string) {
    super(`公開中のバージョンがありません: ${contentId}`);
    this.name = "NoActivePublishError";
  }
}

/** rollback 先のバージョンが存在しないときに投げる。 */
export class VersionNotFoundError extends Error {
  constructor(contentId: string, version: number) {
    super(`バージョンが見つかりません: content=${contentId} version=${version}`);
    this.name = "VersionNotFoundError";
  }
}

/** content 本文の更新 patch。未指定フィールドは現状維持。 */
export type ContentPatch = {
  title?: string;
  body?: string;
  publishScope?: string;
  targets?: unknown;
};

/**
 * F04: content を更新し、新しいバージョンを追記する (公開状態は変えない)。
 *
 * - contents を patch で更新 (updated_by = actor)。
 * - 更新後の状態を content_versions に新バージョンとして保管 (F04.2 履歴保持)。
 * - audit_log に operation=update / table=contents / diff={before, after} を追記 (F04.1)。
 */
export async function updateContent(
  tx: TenantTx,
  actor: PublishActor,
  contentId: string,
  patch: ContentPatch,
): Promise<{ version: number }> {
  const before = await loadContentOrThrow(tx, contentId);

  const next = {
    title: patch.title ?? before.title,
    body: patch.body ?? before.body,
    publishScope: (patch.publishScope ?? before.publishScope) as typeof before.publishScope,
    targets: patch.targets ?? before.targets,
  };

  await tx
    .update(contents)
    .set({
      title: next.title,
      body: next.body,
      publishScope: next.publishScope,
      targets: next.targets,
      updatedBy: actor.userId,
      updatedAt: sql`now()`,
    })
    .where(eq(contents.id, contentId));

  const afterSnapshot = toSnapshot({ ...next, status: before.status });
  const version = await insertVersion(tx, actor, contentId, afterSnapshot, "update");

  await writeAudit(tx, actor, {
    tableName: "contents",
    recordId: contentId,
    operation: "update",
    diff: { before: toSnapshot(before), after: afterSnapshot },
  });

  return { version: version.version };
}

/**
 * F04: content を即公開する (承認フローなし)。
 *
 * - 公開時点の状態を content_versions に保管 (最新バージョンが無ければ作成)。
 * - contents.status = 'published'。
 * - publishes に公開イベントを追記 (どのバージョンを公開したか)。
 * - audit_log に operation=insert / table=publishes を追記 (F04.1)。
 */
export async function publishContent(
  tx: TenantTx,
  actor: PublishActor,
  contentId: string,
): Promise<{ publishId: string; versionId: string; version: number }> {
  const content = await loadContentOrThrow(tx, contentId);

  // 公開するバージョンを確定する。最新バージョンが無ければ現状を v1 として作る。
  let version = await latestVersion(tx, contentId);
  if (!version) {
    version = await insertVersion(tx, actor, contentId, toSnapshot(content), "initial publish");
  }

  await tx
    .update(contents)
    .set({ status: "published", updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(eq(contents.id, contentId));

  // 多重 active publish を避ける (#145 M-3): 既存の公開中 publish をすべて閉じてから新規を立てる。
  // 「1 content = 最大 1 active publish」不変条件を維持し、再公開で旧 publish が放置されるのを防ぐ
  // (DB の部分 UNIQUE index ux_publishes_active_per_content がこの不変条件を最終強制する)。
  // 暗黙の unpublish も監査証跡に残す (F04.1)。
  const superseded = await tx
    .update(publishes)
    .set({ unpublishedAt: sql`now()`, updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(and(eq(publishes.contentId, contentId), isNull(publishes.unpublishedAt)))
    .returning({ id: publishes.id });
  for (const closed of superseded) {
    await writeAudit(tx, actor, {
      tableName: "publishes",
      recordId: closed.id,
      operation: "update",
      diff: {
        before: { unpublishedAt: null },
        after: { unpublishedAt: "now()" },
        reason: "superseded",
      },
    });
  }

  const [pub] = await tx
    .insert(publishes)
    .values({
      schoolId: actor.schoolId,
      contentId,
      versionId: version.id,
      createdBy: actor.userId,
      updatedBy: actor.userId,
    })
    .returning({ id: publishes.id });
  if (!pub) {
    throw new Error("publishes の追記に失敗しました (returning が空)");
  }

  await writeAudit(tx, actor, {
    tableName: "publishes",
    recordId: pub.id,
    operation: "insert",
    diff: { after: { contentId, versionId: version.id, version: version.version } },
  });

  return { publishId: pub.id, versionId: version.id, version: version.version };
}

/**
 * F04: content を非公開化する (公開中の publish を閉じ、content を archived にする)。
 *
 * - 公開中 (unpublished_at IS NULL) の最新 publish を解決。無ければ NoActivePublishError。
 * - publishes.unpublished_at = now()、contents.status = 'archived'。
 * - audit_log に operation=update / table=publishes / diff を追記 (F04.1)。
 */
export async function unpublishContent(
  tx: TenantTx,
  actor: PublishActor,
  contentId: string,
): Promise<{ publishId: string }> {
  await loadContentOrThrow(tx, contentId);

  const [active] = await tx
    .select({ id: publishes.id, versionId: publishes.versionId })
    .from(publishes)
    .where(and(eq(publishes.contentId, contentId), isNull(publishes.unpublishedAt)))
    .orderBy(desc(publishes.publishedAt))
    .limit(1);
  if (!active) {
    throw new NoActivePublishError(contentId);
  }

  await tx
    .update(publishes)
    .set({ unpublishedAt: sql`now()`, updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(eq(publishes.id, active.id));

  await tx
    .update(contents)
    .set({ status: "archived", updatedBy: actor.userId, updatedAt: sql`now()` })
    .where(eq(contents.id, contentId));

  await writeAudit(tx, actor, {
    tableName: "publishes",
    recordId: active.id,
    operation: "update",
    diff: { before: { unpublishedAt: null }, after: { unpublishedAt: "now()" } },
  });

  return { publishId: active.id };
}

/**
 * F04.2: 1-click rollback。指定バージョンの snapshot を contents に復元し、
 * **新しいバージョンとして追記** する (履歴は失わない)。
 *
 * - target version の snapshot を取得。無ければ VersionNotFoundError。
 * - snapshot の本文系フィールド (title/body/publishScope/targets) を contents に復元
 *   (status は復元せず現状維持 — 公開状態は publish/unpublish で管理する)。
 * - 復元結果を content_versions に新バージョンとして追記。
 * - audit_log に operation=insert / table=content_versions / diff を追記 (F04.1)。
 */
export async function rollbackContent(
  tx: TenantTx,
  actor: PublishActor,
  contentId: string,
  targetVersion: number,
): Promise<{ version: number; restoredFrom: number }> {
  const current = await loadContentOrThrow(tx, contentId);

  const [target] = await tx
    .select({ snapshot: contentVersions.snapshot })
    .from(contentVersions)
    .where(
      and(eq(contentVersions.contentId, contentId), eq(contentVersions.version, targetVersion)),
    )
    .limit(1);
  if (!target) {
    throw new VersionNotFoundError(contentId, targetVersion);
  }

  const snap = target.snapshot as Partial<ContentSnapshot>;
  const restored = {
    title: snap.title ?? current.title,
    body: snap.body ?? current.body,
    publishScope: (snap.publishScope ?? current.publishScope) as typeof current.publishScope,
    targets: snap.targets ?? current.targets,
  };

  await tx
    .update(contents)
    .set({
      title: restored.title,
      body: restored.body,
      publishScope: restored.publishScope,
      targets: restored.targets,
      updatedBy: actor.userId,
      updatedAt: sql`now()`,
    })
    .where(eq(contents.id, contentId));

  const restoredSnapshot = toSnapshot({ ...restored, status: current.status });
  const version = await insertVersion(
    tx,
    actor,
    contentId,
    restoredSnapshot,
    `rollback to v${targetVersion}`,
  );

  await writeAudit(tx, actor, {
    tableName: "content_versions",
    recordId: version.id,
    operation: "insert",
    diff: { after: restoredSnapshot, rolledBackFrom: targetVersion },
  });

  return { version: version.version, restoredFrom: targetVersion };
}
