import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { VECTOR_DIM } from "../_shared/pgvector.js";
import { contentVersions } from "../schema/content-versions.js";
import { publishes } from "../schema/publishes.js";

/**
 * F06 (S1): RAG 検索クエリ層 — 生徒対話チャットボットの「根拠」取得 (ADR-028)。
 *
 * 生徒/教員の質問 embedding に最も近い **自校の公開中コンテンツ** を pgvector 距離で top-k 取得し、
 * 後段 (S5 プロンプト builder) が掲示物 Q&A の根拠として LLM に渡すための read 層。
 *
 * ## テナント分離 (CLAUDE.md ルール2 / ADR-019)
 * `school_id` 条件は **書かない**。content_versions / publishes の RLS (tenant_isolation) が
 * `app.current_school_id` で DB レベル強制する。呼び出し側は `withTenantContext` で RLS context を
 * 張った接続/トランザクションで実行し、`db` には BYPASSRLS でない接続ロール (kimiterrace_app) を
 * 渡すこと。アプリ側 WHERE に依存して越境を防ぐ設計は採らない。
 *
 * ## 公開中 (published) 限定
 * active publish (`publishes.unpublished_at IS NULL`) が指す content_versions のみを根拠候補とする
 * (content-detail.ts の activePublish と同じ「現在公開中のバージョン」シグナル)。draft / 公開取消済 /
 * 未公開の版は根拠に使わない。embedding が未生成 (NULL) の版も除外する (S2 バッチ未処理 / マスキング前)。
 *
 * ## マスキング (ルール4)
 * 渡す `queryEmbedding` は **PII マスキング後テキスト**から生成されたものであること
 * (生 PII を Vertex に送らない)。embedding 自体もマスキング後テキストから生成済み (S2)。本モジュールは
 * 距離計算のみで、マスキングの責務は呼び出し側 (S5/S6) と embedding 生成バッチ (S2) が負う。
 *
 * ## スコープ外 (S1 時点)
 * クラス可視性 (publish_scope / targets による生徒のクラス絞り込み) は適用しない。生徒経路の
 * クラススコープ適用は S6 (SSE エンドポイント) 側で session のクラスに基づき行う。本層は school スコープ
 * (RLS) + published までを担う。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/** RAG top-k のデフォルト件数。 */
export const DEFAULT_TOP_K = 5;

/** top-k の上限 (過大要求でコスト/レイテンシが暴れるのを防ぐ)。 */
export const MAX_TOP_K = 20;

/** 検索結果 1 件 = 公開中バージョンの本文 + クエリとの距離。 */
export type RelevantChunk = {
  contentId: string;
  versionId: string;
  version: number;
  title: string;
  body: string;
  /** pgvector cosine 距離 (`<=>`)。0 = 同方向 (最も近い)、小さいほど関連が強い。 */
  distance: number;
};

export type GetRelevantChunksOptions = {
  /** 返す最大件数 (default {@link DEFAULT_TOP_K}、[1, {@link MAX_TOP_K}] にクランプ)。 */
  limit?: number;
};

/**
 * クエリ embedding を pgvector 距離で照合し、自校の **公開中** コンテンツ上位 k 件を返す。
 *
 * 順序は距離昇順 (最も近い順)、距離同値は version_id で決定的に倒す (PR #156 の決定的順序づけ規律)。
 * 該当が無ければ空配列。
 *
 * @param db             RLS context を張った接続/トランザクション (Selectable)
 * @param queryEmbedding マスキング後クエリの embedding (長さは {@link VECTOR_DIM} と一致必須)
 * @param opts.limit     返す最大件数 (default {@link DEFAULT_TOP_K})
 */
export async function getRelevantChunks(
  db: Selectable,
  queryEmbedding: number[],
  opts: GetRelevantChunksOptions = {},
): Promise<RelevantChunk[]> {
  // 次元・値の検証: DB 側の cryptic な dimension mismatch / NaN 距離を避け、呼出側の不正を早期に弾く。
  // VECTOR_DIM は _shared/pgvector.ts の単一ソース (モデル切替時の RAG silent drift 防止)。
  if (queryEmbedding.length !== VECTOR_DIM) {
    throw new Error(
      `getRelevantChunks: embedding 次元が不正です (expected ${VECTOR_DIM}, got ${queryEmbedding.length})`,
    );
  }
  if (!queryEmbedding.every((v) => Number.isFinite(v))) {
    throw new Error("getRelevantChunks: embedding に非有限値 (NaN/Infinity) が含まれます");
  }

  const limit = clampTopK(opts.limit);
  // pgvector のテキスト表現 '[v0,v1,...]' を bind し ::vector にキャストする。全要素が有限数である
  // ことを上で検証済みのため、文字列化による注入リスクはない (数値のみ)。
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;
  // 距離式は SELECT と ORDER BY で同一物を使う (二重評価でも結果は同値、可読性優先)。
  const distance = sql<number>`${contentVersions.embedding} <=> ${vectorLiteral}::vector`;

  const rows = await db
    .select({
      contentId: contentVersions.contentId,
      versionId: contentVersions.id,
      version: contentVersions.version,
      // 公開時に凍結した snapshot 本文 (embedding はこの版のマスキング後テキストから生成済み)。
      title: sql<string>`${contentVersions.snapshot} ->> 'title'`,
      body: sql<string>`${contentVersions.snapshot} ->> 'body'`,
      distance,
    })
    .from(publishes)
    .innerJoin(contentVersions, eq(contentVersions.id, publishes.versionId))
    // active publish (公開中) かつ embedding 生成済の版のみ。school_id は RLS に委ねる。
    .where(and(isNull(publishes.unpublishedAt), isNotNull(contentVersions.embedding)))
    .orderBy(distance, asc(contentVersions.id))
    .limit(limit);

  return rows;
}

/** limit を [1, {@link MAX_TOP_K}] にクランプ (未指定は {@link DEFAULT_TOP_K})。 */
function clampTopK(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_TOP_K;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    return 1;
  }
  return Math.min(limit, MAX_TOP_K);
}
