import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { contentStatus } from "../_shared/enums.js";
import { aiExtractions } from "../schema/ai-extractions.js";
import { contentVersions } from "../schema/content-versions.js";
import { contents } from "../schema/contents.js";
import { publishes } from "../schema/publishes.js";

/**
 * F04: 教員エディタ向けの content 読み取りクエリ層。
 *
 * F04 の安全網 UI (バージョンタイムライン = F04.2 / 公開状態表示 / コンテンツ一覧) が SELECT する
 * read 層。mutation 側は `contents-publish.ts` のドメインサービス、本モジュールは参照のみ。
 *
 * テナント分離は **呼び出し接続の RLS コンテキスト** (`app.current_school_id`、ADR-019) が DB
 * レベルで強制する。呼び出し側 (apps/web の Server Component / `withSession`) が RLS context を
 * 張った接続/トランザクションで実行し、`db` には RLS をバイパスしない接続ロール (kimiterrace_app)
 * を使うこと (CLAUDE.md ルール2)。本モジュールは `school_id` 条件を**書かない** — RLS に委ねる。
 */

/** SELECT だけできれば良い (Drizzle db / トランザクションの両方を受ける)。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

type ContentStatus = (typeof contentStatus.enumValues)[number];

/** 一覧 1 行 (エディタのコンテンツ一覧用、本文は含めない)。 */
export type ContentSummary = {
  id: string;
  title: string;
  status: ContentStatus;
  publishScope: string;
  updatedAt: Date;
};

/** バージョン履歴 1 件 (タイムライン表示用、snapshot 本体は含めず軽量メタのみ)。 */
export type ContentVersionInfo = {
  id: string;
  version: number;
  diffSummary: string | null;
  createdAt: Date;
  createdBy: string | null;
};

/** 公開中の publish 情報 (無ければ null)。 */
export type ActivePublishInfo = {
  id: string;
  versionId: string;
  publishedAt: Date;
};

/** content 詳細 (本体 + バージョン履歴 + 公開状態)。エディタ画面 1 枚分の read モデル。 */
export type ContentDetail = {
  content: {
    id: string;
    title: string;
    body: string;
    publishScope: string;
    status: ContentStatus;
    targets: unknown;
    updatedAt: Date;
  };
  /** version 降順 (新しい順)。F04.2 の「このバージョンに戻す」タイムライン用。 */
  versions: ContentVersionInfo[];
  /** 公開中バージョン。draft / archived では null。 */
  activePublish: ActivePublishInfo | null;
};

/**
 * 自校のコンテンツ一覧を返す (RLS で school スコープ)。更新が新しい順。
 * @param opts.status 指定すると status で絞り込む (例: 公開中のみ)。
 */
export async function listContents(
  db: Selectable,
  opts: { status?: ContentStatus } = {},
): Promise<ContentSummary[]> {
  const base = db
    .select({
      id: contents.id,
      title: contents.title,
      status: contents.status,
      publishScope: contents.publishScope,
      updatedAt: contents.updatedAt,
    })
    .from(contents);
  // updated_at 同値でも順序を決定的にするため id を二次キーにする (Reviewer PR #156 L2)。
  const rows = opts.status
    ? await base
        .where(eq(contents.status, opts.status))
        .orderBy(desc(contents.updatedAt), desc(contents.id))
    : await base.orderBy(desc(contents.updatedAt), desc(contents.id));
  return rows;
}

/**
 * content 1 件の詳細 (本体 + バージョン履歴 + 公開状態) を返す。
 * RLS で不可視 (別テナント / 不存在) なら **null**。
 */
export async function getContentDetail(
  db: Selectable,
  contentId: string,
): Promise<ContentDetail | null> {
  const [content] = await db
    .select({
      id: contents.id,
      title: contents.title,
      body: contents.body,
      publishScope: contents.publishScope,
      status: contents.status,
      targets: contents.targets,
      updatedAt: contents.updatedAt,
    })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);
  if (!content) {
    return null;
  }

  const versions = await db
    .select({
      id: contentVersions.id,
      version: contentVersions.version,
      diffSummary: contentVersions.diffSummary,
      createdAt: contentVersions.createdAt,
      createdBy: contentVersions.createdBy,
    })
    .from(contentVersions)
    .where(eq(contentVersions.contentId, contentId))
    .orderBy(desc(contentVersions.version));

  const [activePublish] = await db
    .select({
      id: publishes.id,
      versionId: publishes.versionId,
      publishedAt: publishes.publishedAt,
    })
    .from(publishes)
    .where(and(eq(publishes.contentId, contentId), isNull(publishes.unpublishedAt)))
    // 多重 active publish (Issue #145) でも published_at 同値時に決定的に選ぶため id を二次キーに
    // する (Reviewer PR #156 L1)。本来 1 content = 最大 1 active publish に正規化すべきは #145。
    .orderBy(desc(publishes.publishedAt), desc(publishes.id))
    .limit(1);

  return { content, versions, activePublish: activePublish ?? null };
}

/** F04.3: content の AI 確信度フラグ用データ (最も低い確信度の抽出 + 根拠引用)。 */
export type ContentConfidence = {
  /** 0.0〜1.0。content に紐づく抽出のうち最小値 (最も自信のない抽出を採る)。 */
  score: number;
  /** 根拠引用を短くまとめた文字列 (evidence の text を連結)。無ければ null。 */
  evidence: string | null;
};

/**
 * evidence jsonb (例: `[{page, span, text}, ...]`) から表示用の根拠文字列を作る。
 * `text` フィールドを持つ要素だけを連結する。空 / 形式不一致は null。
 */
function formatEvidence(raw: unknown): string | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const texts = raw
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : null,
    )
    .filter((t): t is string => t !== null && t.length > 0);
  if (texts.length === 0) {
    return null;
  }
  return texts.join(" / ");
}

/**
 * F04.3: content に紐づく AI 抽出のうち **最も確信度が低いもの** を返す (最も慎重に倒す)。
 *
 * confidence は `contents` ではなく `ai_extractions.confidence_score` (ADR-017) にあるため、
 * content_id で引いて最小 confidence の 1 件を採り、UI (`ConfidenceBadge`、F04.3) に
 * `{ score, evidence }` を渡す。抽出が無い (人手作成など) なら **null** = フラグを出さない。
 *
 * テナント分離は ai_extractions の RLS (tenant_isolation) に委ねる (school_id 条件は書かない)。
 */
export async function getContentConfidence(
  db: Selectable,
  contentId: string,
): Promise<ContentConfidence | null> {
  const [row] = await db
    .select({ score: aiExtractions.confidenceScore, evidence: aiExtractions.evidence })
    .from(aiExtractions)
    .where(eq(aiExtractions.contentId, contentId))
    .orderBy(asc(aiExtractions.confidenceScore))
    .limit(1);
  if (!row) {
    return null;
  }
  return { score: row.score, evidence: formatEvidence(row.evidence) };
}
