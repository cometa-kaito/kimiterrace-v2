import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { VECTOR_DIM } from "../_shared/pgvector.js";
import { contentVersions } from "../schema/content-versions.js";
import { publishes } from "../schema/publishes.js";

/**
 * F06 (#398, #365 follow-up / ADR-007 / CLAUDE.md ルール4): embedding 生成バッチの RLS 密結合
 * クエリ層（公開中・未生成 version の抽出 + embedding の保存）。
 *
 * apps/jobs のバッチ本体 (`embedPendingContent`, #394) はマスキング順序・空テキスト除外・バッチ分割
 * という「壊れると漏れる／非効率になる」ロジックだけを持ち、DB I/O は `EmbeddingBatchPort` に委ねる。
 * 本 module はそのポートが叩く 2 つの SQL を提供し、RLS でテナント分離を **DB レベル強制**する
 * (rag-search.ts と同じ設計、ルール2)。port 実体 (`createPgEmbeddingPort`, apps/jobs) は本関数を
 * `withTenantContext` でラップするだけ。
 *
 * **テナント分離 (ルール2)**: いずれも `school_id` 条件を**書かない**。content_versions / publishes の
 * RLS (`tenant_isolation`、0002) が、呼び出し接続の `app.current_school_id` で自校スコープを強制する。
 * バッチは校ごとに `school_admin` へ降格した context で呼ぶこと (`system_admin` だと
 * `system_admin_full_access` が全校 PERMISSIVE に発火し越境するため不可)。BYPASSRLS 不使用。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-007 (pgvector), ADR-019 (RLS 二層),
 * #393 (Vertex embedding client), #394 (embedPendingContent / EmbeddingBatchPort), #364 (rag-search)。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける、rag-search と同形)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;
/** UPDATE だけできれば良い。 */
type Updatable = Pick<PostgresJsDatabase, "update">;

/** embedding 未生成かつ公開中の content_version (ポートが RLS スコープで抽出する 1 行)。 */
export type PendingEmbeddingVersion = {
  versionId: string;
  /** content_versions.snapshot (jsonb 任意形)。呼び出し側が title/body を埋め込みテキスト化する。 */
  snapshot: unknown;
};

/**
 * number[] を pgvector リテラル `[a,b,...]` にする。次元不一致・非有限値は `RangeError`。
 *
 * 文字列でリテラルを組むため、不正値 (NaN/Infinity, 次元ずれ) を発行前に弾いて silent な
 * 壊れ vector の永続を防ぐ。rag-search.ts の同名 private helper と同じ規約 (将来 `_shared/pgvector.ts`
 * への hoist 候補だが、本 PR は query 層を rag-search に結合させないため独立に持つ)。
 */
function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== VECTOR_DIM) {
    throw new RangeError(
      `saveContentEmbedding: embedding 次元が不正 (${embedding.length}, 期待 ${VECTOR_DIM})`,
    );
  }
  for (const x of embedding) {
    if (!Number.isFinite(x)) {
      throw new RangeError("saveContentEmbedding: embedding に非有限値が含まれる");
    }
  }
  return `[${embedding.join(",")}]`;
}

/**
 * 公開中 (active publish = `unpublished_at IS NULL`) かつ `embedding IS NULL` の content_versions を返す。
 *
 * - **公開中のみ**: active publish が無い (下書き / unpublish 済) version は inner join で除外。
 *   下書き・revoke 済掲示物を embedding 対象にしない (= RAG コンテキストにも乗らない)。
 * - **未生成のみ**: 既に embedding を持つ version は再生成しない (冪等・コスト抑制)。
 * - 走査順は created_at→id 昇順で決定的にする (バッチ/テストの再現性)。
 *
 * @param db RLS コンテキスト (school_admin + school_id) を張った非 BYPASSRLS 接続 / tx
 */
export async function listPendingEmbeddingVersions(
  db: Selectable,
): Promise<PendingEmbeddingVersion[]> {
  const rows = await db
    .select({ versionId: contentVersions.id, snapshot: contentVersions.snapshot })
    .from(contentVersions)
    // active publish (unpublished_at IS NULL) のある version だけ = 公開中。
    .innerJoin(
      publishes,
      and(eq(publishes.versionId, contentVersions.id), isNull(publishes.unpublishedAt)),
    )
    // embedding 未生成のみ。
    .where(isNull(contentVersions.embedding))
    .orderBy(asc(contentVersions.createdAt), asc(contentVersions.id));

  return rows.map((r) => ({ versionId: r.versionId, snapshot: r.snapshot }));
}

/**
 * 1 件の content_version に embedding (マスキング後テキストから生成済み) を保存する。
 *
 * - **`updated_at` を明示更新** (ルール1)。`auditColumns.updatedAt` は INSERT 時 default のみで
 *   `$onUpdate`/トリガを持たないため、明示しないと作成時刻のまま残り監査不整合になる。
 * - **`updated_by` は null** (システムバッチによる派生インデックス更新で、人間 actor は無い)。
 * - **監査ログは書かない**: content_versions に audit トリガは無く、embedding はコンテンツ本文の
 *   派生インデックス (本文自体は version 作成時に監査済)。`audit_log` への明示記録は本文を変える
 *   操作に限る (#398 設計判断1: 派生更新は updated_at で足りる)。
 * - WHERE は id のみ。**他校 version の id を渡しても RLS (`tenant_isolation`) が USING で行を
 *   不可視にし 0 行更新になる** (越境書込防止、ルール2)。
 *
 * @returns 実際に更新された行数 (0 = 対象が自校に存在しない / RLS で弾かれた)
 */
export async function saveContentEmbedding(
  db: Updatable,
  versionId: string,
  embedding: number[],
): Promise<number> {
  const literal = toVectorLiteral(embedding);
  // RETURNING で更新行を取り、件数で「自校に存在し更新できたか」を判定する (contents-publish.ts と同形)。
  // 他校 id を渡された場合は RLS USING で 0 行 → length 0 で呼び出し側が越境を検知できる。
  const updated = await db
    .update(contentVersions)
    .set({
      embedding: sql`${literal}::vector`,
      updatedAt: sql`now()`,
      updatedBy: null,
    })
    .where(eq(contentVersions.id, versionId))
    .returning({ id: contentVersions.id });
  return updated.length;
}
