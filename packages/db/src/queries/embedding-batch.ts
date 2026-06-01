import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { VECTOR_DIM } from "../_shared/pgvector.js";
import { contentVersions } from "../schema/content-versions.js";
import { publishes } from "../schema/publishes.js";

/**
 * F06 (#398, ADR-007 / CLAUDE.md ルール4): 公開コンテンツ embedding 生成バッチの DB クエリ層。
 *
 * apps/jobs のバッチ本体（#394 `embedPendingContent`）が依存逆転で参照する `EmbeddingBatchPort` の
 * 実体 SQL。**`rag-search.ts` (#364) と同じ join 形・RLS 規律**を、生成側（書込）として持つ:
 *
 * - **テナント分離 (ルール2)**: `school_id` 条件を**書かない**。content_versions / publishes の RLS
 *   (`tenant_isolation`、ADR-019、FOR ALL = SELECT/UPDATE 双方) が、呼び出し接続の
 *   `app.current_school_id` で自校スコープを DB レベル強制する。`withTenantContext` を張った
 *   非 BYPASSRLS 接続/tx で呼ぶこと（BYPASSRLS 不使用、ルール2）。context 未設定なら
 *   deny-by-default で listPending は 0 件・saveEmbedding は影響 0 行。
 * - **公開中のみ**: active publish (`unpublished_at IS NULL`) のある version だけを inner join で拾う。
 *   下書き・unpublish 済の掲示物に embedding を生成しても RAG (#364) は引かないため無駄。逆に
 *   生成対象を公開中に限ることで、未公開掲示物の本文が Vertex へ送られる面も最小化する（ルール4 補強）。
 * - **未生成のみ**: `embedding IS NULL` の version だけを対象にする（再実行で既生成を作り直さない）。
 * - **PII (ルール4)**: 本層は snapshot をそのまま返すのみ。マスキング → embedding 生成の順序は
 *   バッチ本体 (#394) が `maskPII` で担保する。生 PII を Vertex へ送らない境界は上流に固定する。
 *
 * 関連: ADR-007 (pgvector), ADR-019 (RLS 二層), ADR-028 (回答ポリシー), #364 (rag-search.ts),
 * #393/#394 (embedding client / batch 本体)。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;
/** UPDATE だけできれば良い。 */
type Updatable = Pick<PostgresJsDatabase, "update">;

/** embedding 未生成かつ公開中の content_version（RLS スコープ済）。 */
export type PendingEmbedding = {
  versionId: string;
  /** content_versions.snapshot（jsonb 任意形）。title/body を埋め込む（#394 snapshotToEmbeddingText）。 */
  snapshot: unknown;
};

/**
 * number[] を pgvector リテラル `[a,b,...]` にする。次元不一致・非有限値は `RangeError`。
 *
 * `vector` customType は `dataType()` のみ定義し driver 変換を持たないため、drizzle の
 * `.set({ embedding: number[] })` は PG 配列 `{...}` として誤直列化される。`rag-search.ts` の
 * 検索側と同様に **リテラル `[...]::vector` を sql フラグメントで bind** する。次元不一致は
 * RAG の silent drift（cosine 距離が無意味化し誤った掲示物が引かれても気づけない、ADR-007）を
 * 生むため、クエリ発行前に弾く。検索側 `toVectorLiteral` と同一規律（DRY 化は follow-up）。
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
 * @param db `withTenantContext` を張った非 BYPASSRLS 接続 / tx
 * @returns version_id 昇順（再実行で順序が安定し、resume / テストが決定的になる）
 */
export async function listPendingEmbeddings(db: Selectable): Promise<PendingEmbedding[]> {
  const rows = await db
    .select({ versionId: contentVersions.id, snapshot: contentVersions.snapshot })
    .from(contentVersions)
    // active publish (unpublished_at IS NULL) のある version だけ = 公開中。
    .innerJoin(
      publishes,
      and(eq(publishes.versionId, contentVersions.id), isNull(publishes.unpublishedAt)),
    )
    // embedding 未生成のみ（再実行で既生成を作り直さない）。
    .where(isNull(contentVersions.embedding))
    .orderBy(asc(contentVersions.id));

  return rows.map((r) => ({ versionId: r.versionId, snapshot: r.snapshot }));
}

/**
 * 1 件の content_version に embedding を保存する。
 *
 * - **`updated_at` を明示更新** する（ルール1: auditColumns の updated_at は INSERT 時のみ default で
 *   `$onUpdate`/トリガが無いため、UPDATE で明示しないと作成時刻のまま残り監査不整合になる、
 *   PR #286 Med-1）。`updated_by` はシステムバッチのため null（ルール1: システム作成は null）。
 * - **RLS スコープの安全網**: WHERE は `id = versionId` のみで `school_id` を書かない。RLS USING が
 *   自校行だけを可視にするため、別校の version_id を渡しても**影響 0 行**になる（テナント越境の
 *   embedding 上書きを DB レベルで遮断、ルール2）。呼び出し側（アダプタ）は戻り値 1 を期待し、
 *   0 を「スコープ外 / 不在」として扱うこと。id は PK のため 2 以上は発生しない。
 *
 * @param db `withTenantContext` を張った非 BYPASSRLS 接続 / tx
 * @returns 実際に更新された行数（0 = スコープ外 / 不在、1 = 成功）
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
    .returning({ id: contentVersions.id });
  return updated.length;
}
