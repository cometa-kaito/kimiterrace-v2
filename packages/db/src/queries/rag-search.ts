import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { VECTOR_DIM } from "../_shared/pgvector.js";
import { contentVersions } from "../schema/content-versions.js";
import { contents } from "../schema/contents.js";
import { publishes } from "../schema/publishes.js";

/**
 * F06 (#364, ADR-028): 生徒 Q&A の RAG 検索クエリ層。
 *
 * 質問文から生成した embedding に対し、**公開中** (active publish = `unpublished_at IS NULL`) の
 * `content_versions` を pgvector の cosine 距離 (`<=>`) で近い順に top-k 返す。
 *
 * - **テナント分離 (ルール2)**: `school_id` 条件を**書かない**。content_versions / publishes /
 *   contents すべての RLS (`tenant_isolation`、ADR-019) が、呼び出し接続の
 *   `app.current_school_id` で自校スコープを DB レベル強制する。context 未設定なら
 *   deny-by-default で 0 件。本関数は `withTenantContext` を張った接続/tx で呼ぶこと。
 * - **公開中のみ**: active publish が無い (下書き / unpublish 済) version は inner join で除外。
 *   下書き・revoke 済掲示物が RAG コンテキストに漏れない (student-qa シーケンス図)。
 * - **PII (ルール4)**: embedding は **マスキング後テキスト** から生成済み (ADR-007、S2)。本関数は
 *   件数とタイトル・参照 id のみを返し、生 PII は読み出さない。Gemini へ渡す本文の取得とマスキングは
 *   呼び出し側 (S5/S6) の責務。
 * - 距離計算は厳密 (seq scan)。MVP の規模では十分。ANN index (HNSW/IVFFlat) は将来の最適化
 *   (schema/migration レーン) に切り出す。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-007 (pgvector),
 * ADR-017 (confidence), ADR-019 (RLS 二層), ADR-028 (回答ポリシー)。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** RAG 検索の 1 ヒット (公開中コンテンツの参照 + 類似度)。 */
export type RagMatch = {
  contentId: string;
  /** ヒットした公開中バージョン (= embedding を持つ content_version)。 */
  versionId: string;
  title: string;
  /** cosine 類似度 (1 - cosine 距離)。高いほど質問に近い。 */
  similarity: number;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/**
 * number[] を pgvector リテラル `[a,b,...]` にする。次元不一致・非有限値は `RangeError`。
 * 次元不一致は RAG の silent drift (ADR-007 / pgvector.ts の VECTOR_DIM 単一ソース) を防ぐため
 * クエリ発行前に弾く。
 */
function toVectorLiteral(embedding: number[]): string {
  if (embedding.length !== VECTOR_DIM) {
    throw new RangeError(
      `getRelevantPublishedContent: embedding 次元が不正 (${embedding.length}, 期待 ${VECTOR_DIM})`,
    );
  }
  for (const x of embedding) {
    if (!Number.isFinite(x)) {
      throw new RangeError("getRelevantPublishedContent: embedding に非有限値が含まれる");
    }
  }
  return `[${embedding.join(",")}]`;
}

/**
 * 公開中コンテンツを質問 embedding に近い順 (cosine) に top-k 返す。
 *
 * @param db             RLS コンテキストを張った非 BYPASSRLS 接続 / tx
 * @param queryEmbedding 質問文の embedding (長さ = VECTOR_DIM、全要素有限)
 * @param opts.limit     返却件数 (既定 5、1〜20 にクランプ)
 */
export async function getRelevantPublishedContent(
  db: Selectable,
  queryEmbedding: number[],
  opts: { limit?: number } = {},
): Promise<RagMatch[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const literal = toVectorLiteral(queryEmbedding);
  // cosine 距離。literal は 1 度だけバインドし、並びは出力エイリアス "distance" で行う。
  const distance = sql<number>`${contentVersions.embedding} <=> ${literal}::vector`;

  const rows = await db
    .select({
      contentId: contentVersions.contentId,
      versionId: contentVersions.id,
      title: contents.title,
      distance,
    })
    .from(contentVersions)
    // active publish (unpublished_at IS NULL) のある version だけ = 公開中。
    .innerJoin(
      publishes,
      and(eq(publishes.versionId, contentVersions.id), isNull(publishes.unpublishedAt)),
    )
    .innerJoin(contents, eq(contents.id, contentVersions.contentId))
    // embedding 未生成 (S2 バッチ未処理) の version は検索対象外。
    .where(sql`${contentVersions.embedding} is not null`)
    // 近い順。距離同値でも決定的にするため version_id を二次キーにする。
    .orderBy(sql`distance asc`, asc(contentVersions.id))
    .limit(limit);

  return rows.map((r) => ({
    contentId: r.contentId,
    versionId: r.versionId,
    title: r.title,
    similarity: 1 - Number(r.distance),
  }));
}
