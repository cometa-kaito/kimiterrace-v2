import { and, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { VECTOR_DIM } from "../_shared/pgvector.js";
import { contentVersions } from "../schema/content-versions.js";
import { publishes } from "../schema/publishes.js";

/**
 * F06 (#398, ADR-007 / CLAUDE.md ルール2・ルール4): embedding 生成バッチの DB クエリ層。
 *
 * 公開バッチ（apps/jobs）が「公開中・embedding 未生成」の content_versions を 1 校 RLS スコープで
 * 抽出し（{@link listPendingEmbeddingVersions}）、マスキング後テキストから生成した embedding を
 * 書き戻す（{@link saveContentEmbedding}）ための SELECT / UPDATE。
 *
 * - **テナント分離 (ルール2)**: どちらも `school_id` 条件を**書かない**。content_versions / publishes の
 *   RLS（tenant_isolation、ADR-019）が呼び出し接続の `app.current_school_id` で自校スコープを DB レベル
 *   強制する。呼出側（apps/jobs の createPgEmbeddingPort）は `withTenantContext`（school_admin、
 *   非 BYPASSRLS = kimiterrace_app）を張った `tx` を渡すこと。他校 version は SELECT で 0 行・UPDATE で
 *   0 行に倒れる（越境して読めない / 書けない）。
 * - **公開中のみ**: active publish（`unpublished_at IS NULL`）のある version だけを inner join で拾う。
 *   下書き・unpublish 済を embedding 対象にしない（rag-search.ts と同じ join 形 = RAG に乗る集合と一致）。
 * - **PII (ルール4)**: 本層は embedding（マスキング後テキスト由来）の出し入れのみ。マスキングは
 *   上流（embedPendingContent）の責務で、生 PII は本層を通らない。
 *
 * 関連: rag-search.ts（読み取り側）、ADR-007（pgvector / VECTOR_DIM 単一ソース）。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;
/** UPDATE だけできれば良い。 */
type Updatable = Pick<PostgresJsDatabase, "update">;

/** embedding 未生成・公開中の content_version（RLS スコープ済）。 */
export type PendingEmbeddingVersion = {
  versionId: string;
  /** content_versions.snapshot（jsonb 任意形）。title/body を埋め込みテキストにする。 */
  snapshot: unknown;
};

/**
 * number[] を pgvector リテラル `[a,b,…]` にする（rag-search.ts の toVectorLiteral と同作法）。
 * `vector` customType は toDriver を持たず drizzle の `set({ embedding: number[] })` では正しく
 * シリアライズされないため `[...]::vector` リテラルで書く。次元不一致・非有限値は **永続前に弾く**
 * （embedding は保存され cosine 検索の silent drift を生むため fail-fast、ADR-007 / VECTOR_DIM 単一ソース）。
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
 * 公開中（active publish）かつ embedding 未生成の content_versions を返す（RLS スコープ済）。
 *
 * @param db RLS コンテキストを張った非 BYPASSRLS 接続 / tx（school スコープ）
 */
export async function listPendingEmbeddingVersions(
  db: Selectable,
): Promise<PendingEmbeddingVersion[]> {
  const rows = await db
    .select({ versionId: contentVersions.id, snapshot: contentVersions.snapshot })
    .from(contentVersions)
    // active publish（unpublished_at IS NULL）のある version だけ = 公開中。1 content = 最大 1 active
    // publish（publishes の部分 unique）のため version あたり最大 1 行で、行多重化しない。
    .innerJoin(
      publishes,
      and(eq(publishes.versionId, contentVersions.id), isNull(publishes.unpublishedAt)),
    )
    // S2 バッチ未処理（embedding 未生成）のみ。
    .where(isNull(contentVersions.embedding));
  return rows.map((r) => ({ versionId: r.versionId, snapshot: r.snapshot }));
}

/**
 * 1 件の content_version に embedding を書き戻す（RLS スコープ済 tx で呼ぶこと）。
 *
 * `updated_at` を明示更新する（ルール1: auditColumns は INSERT 既定のみで $onUpdate/トリガを持たない）。
 * `updated_by` はシステムバッチによる派生インデックス更新のため null。`school_id` 条件は書かず RLS が
 * 他校 version への UPDATE を 0 行に倒す（ルール2）。
 *
 * @returns 実際に更新された行数（RLS で他校 version を渡すと 0、対象不在も 0）。
 */
export async function saveContentEmbedding(
  db: Updatable,
  versionId: string,
  embedding: number[],
): Promise<number> {
  const literal = toVectorLiteral(embedding);
  const updated = await db
    .update(contentVersions)
    .set({
      embedding: sql`${literal}::vector`,
      updatedAt: new Date(),
      updatedBy: null,
    })
    .where(eq(contentVersions.id, versionId))
    // 影響行数は `.returning()` 配列長で取る（codebase 規約、teacher-inputs.ts 等）。RLS で他校
    // version を渡すと 0 行が返り、越境書込みが起きていないことを呼出側がアサートできる。
    .returning({ id: contentVersions.id });
  return updated.length;
}
