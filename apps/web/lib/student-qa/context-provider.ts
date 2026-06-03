import type { ChatContext, EmbeddingClient } from "@kimiterrace/ai";
import { getContentDetail, getRelevantPublishedContent, listContents } from "@kimiterrace/db";
import type { TenantTx } from "@kimiterrace/db";
import type { ContextProvider } from "./chat-service";

/**
 * F06 (#42 第2スライス, #369 follow-up): 生徒 Q&A の **コンテキストプロバイダ具体実装**。
 *
 * {@link executeChat}（chat-service.ts）が注入する {@link ContextProvider} の MVP 実装。
 * 「当該生徒に見せてよい公開中コンテンツ」を取得して grounding 用の {@link ChatContext} を返す。
 *
 * **2 つの provider（#369 RAG 配線）**:
 * - {@link createRagContentProvider}: マスク済み質問を embedding 化 → `getRelevantPublishedContent`
 *   （cosine 近傍 top-k、RLS 自校 + 公開中 + 生徒可視 scope はクエリ層が強制 #481）で意味的 grounding。
 *   route 層が注入する本番経路。**ベクトル検索が 0 件なら下記 MVP にフォールバック**する。
 * - {@link createPublishedContentProvider}: 更新の新しい順に bounded 件数を取得する直接取得 MVP。
 *   RAG のフォールバック先 + 単体でもテスト可能。embedding 投入バッチ（#365/#398）実行前は
 *   `content_versions.embedding` が全 NULL でベクトル検索が 0 件になるため、フォールバックで
 *   grounding を空にしない（バッチ実行後は自動で意味的 RAG に切り替わる、コード変更不要）。
 * - **テナント分離 (ルール2)**: `school_id` 条件を**書かない**。`listContents` / `getContentDetail` が
 *   呼び出し接続の RLS (`tenant_isolation`, ADR-019) で自校スコープを DB レベル強制する。本実装は
 *   `withTenantContext` を張った tx で呼ばれる前提（caller=route 層の責務）。
 * - **公開状態の権威ソース**: `contents.status='published'` は安価な事前フィルタに用い、
 *   **最終ゲートは `getContentDetail` の `activePublish !== null`**（= active publish が存在し
 *   `unpublished_at IS NULL`）。status フラグと実 publish 状態の drift（多重 active publish #145 等）を
 *   除外し、unpublish 済 / 下書きを grounding に載せない（rag-search.ts の inner join 条件と同等の権威性）。
 * - **PII (ルール4)**: 本実装は title/body を **マスクせず**そのまま返す。マスキングは呼び出し側
 *   （chat-service の step 4）が `maskPII` で行い、`findUnmaskedPii` で fail-closed する契約。
 *   {@link ChatContext} の docstring が「マスク済みである前提」と述べるのは route→chat-service の
 *   下流契約であり、本プロバイダはその **上流（生 body 取得）** に位置する。
 * - **class/homeroom ターゲティング**: `publishes` は school 単位で classId を持たないため、
 *   `publishScope='class'/'homeroom'` の **classId 厳密一致は未対応**（rag-search.ts も同様）。
 *   本 MVP は `private` のみ除外して生徒可視スコープに寄せる安全側の既定とし、classId 厳密一致は
 *   rag-search と共通の cross-cutting follow-up とする。引数 `classId` は将来の絞り込み用に保持。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-007 (pgvector),
 * ADR-019 (RLS 二層), ADR-028 (回答ポリシー), #373 (executeChat 注入境界)。
 */

/** grounding に載せる公開中コンテンツの既定件数。プロンプト肥大とコストを抑える bounded 既定。 */
const DEFAULT_LIMIT = 6;
/** 取得件数の上限（濫用・プロンプト肥大の防御）。 */
const MAX_LIMIT = 20;

/**
 * 生徒に見せてよい publish scope。`private` は生徒向け broadcast でないため grounding から除外する
 * （CLAUDE.md「迷ったら安全側」）。`class`/`homeroom` の classId 厳密一致は publishes が school 単位の
 * ため本 MVP では未対応（follow-up）だが、scope 種別としては生徒可視に含める。
 */
const STUDENT_VISIBLE_SCOPES: ReadonlySet<string> = new Set(["school", "class", "homeroom"]);

/** {@link createPublishedContentProvider} の任意設定。 */
export type PublishedContentProviderOptions = {
  /** 取得する公開中コンテンツの最大件数（既定 {@link DEFAULT_LIMIT}、1〜{@link MAX_LIMIT} にクランプ）。 */
  limit?: number;
};

/**
 * 公開中コンテンツを直接取得する {@link ContextProvider} を生成する。
 *
 * 取得手順:
 *  1. `listContents(tx, { status: 'published' })` で公開中候補を更新新しい順に取得（RLS で自校）。
 *  2. 生徒可視 scope（`private` 除外）に絞り、`limit` 件にクランプ。
 *  3. 各候補を `getContentDetail` で本文込み取得し、**`activePublish` が存在する**ものだけ採用
 *     （権威的な公開状態ゲート）。RLS 不可視（別テナント / 不存在）は `null` で除外。
 *  4. `{ id, title, body }`（{@link ChatContext}）に整形して返す。順序は手順 1 の決定的順序を維持。
 *
 * @param opts.limit grounding 件数上限（既定 6）
 */
export function createPublishedContentProvider(
  opts: PublishedContentProviderOptions = {},
): ContextProvider {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  return async (
    tx: TenantTx,
    _params: { classId: string | null },
  ): Promise<readonly ChatContext[]> => {
    // 1) 公開中候補（本文を含まない軽量 summary、更新新しい順で決定的）。
    const candidates = await listContents(tx, { status: "published" });

    // 2) 生徒可視 scope に絞り、grounding 件数にクランプ（private を弾いてから limit を消費する）。
    const visible = candidates
      .filter((c) => STUDENT_VISIBLE_SCOPES.has(c.publishScope))
      .slice(0, limit);

    // 3) 本文 + 権威的公開状態（activePublish）を取得。順序を保つため Promise.all で並列取得。
    const details = await Promise.all(visible.map((c) => getContentDetail(tx, c.id)));

    // 4) active publish を持つものだけ採用し ChatContext に整形（順序は visible のまま）。
    const contexts: ChatContext[] = [];
    for (const detail of details) {
      if (detail && detail.activePublish !== null) {
        contexts.push({
          id: detail.content.id,
          title: detail.content.title,
          body: detail.content.body,
        });
      }
    }
    return contexts;
  };
}

/** {@link createRagContentProvider} の設定。 */
export type RagContentProviderOptions = {
  /** 注入する Vertex embedding クライアント（マスク済み質問 → ベクトル、ADR-005/007）。 */
  embeddingClient: EmbeddingClient;
  /** grounding 件数上限（既定 {@link DEFAULT_LIMIT}、ベクトル検索 / フォールバック双方に適用）。 */
  limit?: number;
};

/**
 * ベクトル類似検索（RAG）で grounding する {@link ContextProvider} を生成する。
 *
 * 手順:
 *  1. **マスク済み質問**（chat-service が step で先にマスク、ルール4）を embedding 化（1 ベクトル）。
 *     空質問はベクトル検索せず即フォールバック。
 *  2. `getRelevantPublishedContent` で cosine 近傍 top-k を取得（`school_id` 非記述 → RLS で自校、
 *     公開中 inner join、生徒可視 scope=`private` 除外はクエリ層が強制 #481）。
 *  3. 各ヒットを `getContentDetail` で本文込み取得し `activePublish !== null` ゲート（権威的公開状態）。
 *  4. 使える context が 1 件以上あればそれを返す。0 件なら **MVP 直接取得にフォールバック**。
 *
 * **フォールバックの意義**: embedding 投入バッチ（#365/#398）実行前は `content_versions.embedding` が
 * 全 NULL でベクトル検索が 0 件になる。フォールバックで「最近の公開掲示物」を grounding し、空答弁への
 * 退行を防ぐ。バッチ実行後は 0 件でなくなり自動で意味的 RAG に切り替わる（コード変更不要）。
 *
 * **PII（ルール4）**: embedding には **マスク済み質問のみ** を渡す（生 PII を Vertex embedding へ送らない）。
 * title/body は本 provider ではマスクせず返し、chat-service の fail-closed マスキングに委ねる（MVP と同契約）。
 * **エラー方針**: embedding 生成エラー（次元不一致 / Vertex 障害）は **握り潰さず伝播**（route が SSE error
 * に整形する誠実な失敗）。「embedding 未投入」はエラーでなく 0 件ヒット＝正常系でフォールバックに乗る。
 *
 * @param opts.embeddingClient 質問 embedding クライアント（caller が env から生成して注入）
 * @param opts.limit grounding 件数上限（既定 6）
 */
export function createRagContentProvider(opts: RagContentProviderOptions): ContextProvider {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const fallback = createPublishedContentProvider({ limit });

  return async (
    tx: TenantTx,
    params: { classId: string | null; maskedQuestion: string },
  ): Promise<readonly ChatContext[]> => {
    const question = params.maskedQuestion.trim();
    if (question.length > 0) {
      // embedding エラーは握り潰さず伝播（誠実な失敗）。次元検証は embed() / rag-search 双方が行う。
      const [embedding] = await opts.embeddingClient.embed([question]);
      if (embedding) {
        const matches = await getRelevantPublishedContent(tx, embedding, { limit });
        if (matches.length > 0) {
          // 本文 + 権威的公開状態を取得（順序保持のため Promise.all、similarity 降順は matches のまま）。
          const details = await Promise.all(matches.map((m) => getContentDetail(tx, m.contentId)));
          const contexts: ChatContext[] = [];
          for (const detail of details) {
            if (detail && detail.activePublish !== null) {
              contexts.push({
                id: detail.content.id,
                title: detail.content.title,
                body: detail.content.body,
              });
            }
          }
          if (contexts.length > 0) return contexts;
        }
      }
    }
    // ベクトル検索が 0 件（embedding 未投入 / 該当なし / 空質問）→ 最近の公開掲示物にフォールバック。
    return fallback(tx, params);
  };
}
