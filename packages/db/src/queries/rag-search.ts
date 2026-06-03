import { type SQL, and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PublishScope } from "../_shared/enums.js";
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
 * - **生徒可視 scope + class 境界 (#481/#481-2)**: `opts.audience` で閲覧者の class 境界を強制する。
 *   生徒 (`kind:"student"`) は `school` を無条件、`class`/`homeroom` は `contents.targets`（jsonb の
 *   class_id 配列）に生徒の classId を含むものだけに絞る（classId 無しは school のみ）。教員
 *   (`kind:"staff"`) と audience 未指定（後方互換）は scope 種別のみ（school/class/homeroom）で
 *   classId 非依存。いずれも `private` を grounding から除外する。`canStudentSeeContent`（apps/web
 *   `visibility.ts`）と同一の audience 意味論で、**別クラス向け掲示物が生徒 Q&A に混入しない**（F04 安全網
 *   「公開先と一致しない magic_link アクセスは 403」を RAG grounding にも適用）。
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
 * 生徒 grounding に載せてよい publish scope (#481)。`private` は生徒向け broadcast でないため除外する
 * (CLAUDE.md「迷ったら安全側」/ ルール4)。直接取得 provider (apps/web `context-provider.ts` の
 * `STUDENT_VISIBLE_SCOPES`) と**同一集合**にして 2 経路の生徒可視判定を揃える単一ソース。
 * `satisfies readonly PublishScope[]` で enum (`["school","class","homeroom","private"]`) とのズレを
 * コンパイル時に検出する (ルール3、`private` を足し忘れ/綴り誤りで素通りするのを防ぐ)。
 */
export const STUDENT_VISIBLE_PUBLISH_SCOPES = [
  "school",
  "class",
  "homeroom",
] as const satisfies readonly PublishScope[];

/**
 * RAG grounding の閲覧者種別（#481-2）。生徒は自クラス境界（`class`/`homeroom` は classId 厳密一致）に
 * 縛り、教員はクラス非バインド（校内の生徒可視 scope すべて）。`canStudentSeeContent`（apps/web
 * `visibility.ts`）の audience 意味論を RAG クエリ層へ展開した単一ソース（2 経路で判定が乖離しない）。
 */
export type RagAudience = { kind: "student"; classId: string | null } | { kind: "staff" };

/**
 * classId 厳密一致を要する scope（#481-2）。`school` は全校 broadcast で classId 非依存、`private` は
 * 生徒・教員いずれの grounding からも除外（下書き）。`satisfies` で enum とのズレをコンパイル時検出。
 */
const CLASS_TARGETED_SCOPES = ["class", "homeroom"] as const satisfies readonly PublishScope[];

/**
 * audience に応じた `publish_scope` の WHERE 句を作る（#481/#481-2）。
 * - staff / 未指定（後方互換）: 生徒可視 scope 種別のみ（school/class/homeroom、private 除外）。
 * - student + classId: `school` は無条件、`class`/`homeroom` は `contents.targets` に classId を含むもの。
 * - student + classId 無し: `class`/`homeroom` は突合不能ゆえ除外し `school` のみ（`canStudentSeeContent`
 *   の `no_class_context` と同じ安全側）。
 *
 * targets の jsonb 突合は `@>`（containment）。bind は `JSON.stringify([classId])::jsonb`（postgres
 * ドライバは `sql.json` ラッパでなく文字列 + `::jsonb` キャストで直列化する、[[pg-date-bind-enum-insert]]）。
 */
function audienceScopeFilter(audience: RagAudience | undefined): SQL {
  if (!audience || audience.kind === "staff") {
    return inArray(contents.publishScope, STUDENT_VISIBLE_PUBLISH_SCOPES);
  }
  if (!audience.classId) {
    return eq(contents.publishScope, "school");
  }
  const classId = audience.classId;
  return (
    or(
      eq(contents.publishScope, "school"),
      and(
        inArray(contents.publishScope, CLASS_TARGETED_SCOPES),
        sql`${contents.targets} @> ${JSON.stringify([classId])}::jsonb`,
      ),
    ) ?? sql`false`
  );
}

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
  opts: { limit?: number; audience?: RagAudience } = {},
): Promise<RagMatch[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const literal = toVectorLiteral(queryEmbedding);
  // cosine 距離。select の sql フラグメントは AS 別名を発行しないため、ORDER BY では
  // 出力エイリアスを参照できない (PG 42703)。getAdReach と同様、ORDER BY で式を再掲する。
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
    .where(
      and(
        // embedding 未生成 (S2 バッチ未処理) の version は検索対象外。
        sql`${contentVersions.embedding} is not null`,
        // 生徒可視 scope + audience の class 境界 (#481/#481-2)。private 除外も audienceScopeFilter 内。
        audienceScopeFilter(opts.audience),
      ),
    )
    // 近い順 (距離昇順 = ASC が SQL 既定)。距離同値でも決定的にするため version_id を二次キーにする。
    .orderBy(sql`${contentVersions.embedding} <=> ${literal}::vector`, asc(contentVersions.id))
    .limit(limit);

  return rows.map((r) => ({
    contentId: r.contentId,
    versionId: r.versionId,
    title: r.title,
    similarity: 1 - Number(r.distance),
  }));
}
