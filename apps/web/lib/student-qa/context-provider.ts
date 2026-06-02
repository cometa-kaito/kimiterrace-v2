import type { ChatContext } from "@kimiterrace/ai";
import { getContentDetail, listContents } from "@kimiterrace/db";
import type { TenantTx } from "@kimiterrace/db";
import type { ContextProvider } from "./chat-service";

/**
 * F06 (#42 第2スライス, #369 follow-up): 生徒 Q&A の **コンテキストプロバイダ具体実装**。
 *
 * {@link executeChat}（chat-service.ts）が注入する {@link ContextProvider} の MVP 実装。
 * 「当該生徒に見せてよい公開中コンテンツ」を取得して grounding 用の {@link ChatContext} を返す。
 *
 * **このスライスの境界（正直に明記）**:
 * - **直接取得 grounding**: 質問 embedding によるベクトル類似度 top-k（`getRelevantPublishedContent`,
 *   packages/db `rag-search.ts`）は **別 follow-up**（embedding 生成は packages/ai 依存・S2 バッチ前提）。
 *   本実装は更新の新しい順に bounded 件数を取得する MVP grounding。chat-service の docstring
 *   「RAG ベクトルは別 follow-up、直接取得で MVP grounding」と整合。
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

  return async (tx: TenantTx, _params: { classId: string }): Promise<readonly ChatContext[]> => {
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
