import type { ChatContext, EmbeddingClient } from "@kimiterrace/ai";
import { getContentDetail, getRelevantPublishedContent, listContents } from "@kimiterrace/db";
import type { RagAudience, RagMatch, TenantTx } from "@kimiterrace/db";
import { normalizeTargets } from "@/lib/contents/visibility";
import type { GroundingResult } from "./chat-service";

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
 * - **class/homeroom ターゲティング (#481-2)**: `params.audience` の class 境界を両 provider で強制する。
 *   生徒 (`kind:"student"`) の `class`/`homeroom` は `contents.targets` に生徒の classId を含むものだけを
 *   採用する（RAG 経路は rag-search が SQL で、直接取得経路は {@link collectActiveContexts} が
 *   getContentDetail の targets で突合）。教員 (`kind:"staff"`) はクラス非バインド。`canStudentSeeContent`
 *   （visibility.ts）と同一判定で、**別クラス向け掲示物が生徒 Q&A に混入しない**（F04 安全網）。
 *
 * 関連: F06 (docs/requirements/functional/F06-student-qa.md), ADR-007 (pgvector),
 * ADR-019 (RLS 二層), ADR-028 (回答ポリシー), #373 (executeChat 注入境界)。
 */

/** grounding に載せる公開中コンテンツの既定件数。プロンプト肥大とコストを抑える bounded 既定。 */
const DEFAULT_LIMIT = 6;
/** 取得件数の上限（濫用・プロンプト肥大の防御）。 */
const MAX_LIMIT = 20;

/**
 * F06 grounding 採用しきい値（ADR-028 §結果 追補, 2026-06-03 ユーザー確定）= **コサイン類似度 0.70**。
 *
 * **方向性（重要・取り違え注意）**: pgvector の `<=>` は cosine **距離**（0 = 完全一致、2 = 真逆）で、
 * `getRelevantPublishedContent` はこれを **similarity = 1 - distance** に変換して返す（高いほど近い）。
 * よって採用条件「similarity ≥ 0.70」は **cosine 距離 ≤ 0.30** と等価。距離で比較すると不等号が反転する
 * ため、本コードでは必ず **similarity 値で比較**する（`>=` で 0.70 ちょうども採用）。
 *
 * 役割: RAG 近傍 top-k のうち本しきい値を満たすチャンクだけを grounding (掲示準拠) に採用する。
 * 満たすものが 0 件なら「掲示に根拠なし」= general_supplement モード（ADR-028 §3、ラベル付き一般補足 +
 * 学校固有事実の推測抑止 + 先生誘導）へ落とす。
 */
export const GROUNDING_SIMILARITY_THRESHOLD = 0.7;

/**
 * 直接取得経路の scope 種別 **粗フィルタ**。`private` は生徒向け broadcast でないため grounding から
 * 除外する（CLAUDE.md「迷ったら安全側」）。`class`/`homeroom` の classId 厳密一致はこの集合では行わず、
 * targets を持つ {@link isVisibleToAudience}（getContentDetail 後）で突合する（#481-2）。
 */
const STUDENT_VISIBLE_SCOPES: ReadonlySet<string> = new Set(["school", "class", "homeroom"]);

/**
 * 本モジュールの provider が返す **narrow な** 関数型。{@link ContextProvider}（union 戻り）に代入可能だが、
 * 戻り値を `GroundingResult` に固定して呼び出し側で `.mode` / `.contexts` を直接読めるようにする
 * （factory を `ContextProvider` で注釈すると戻りが union に広がり narrowing が要るため）。
 */
type GroundingProvider = (
  tx: TenantTx,
  params: { audience: RagAudience; maskedQuestion: string },
) => Promise<GroundingResult>;

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
 * **grounding モード（ADR-028 §3）**: 本 provider は「更新の新しい順」の **直接取得** であり、質問との
 * 意味的な近さ（cosine 類似度）を一切評価しない。したがって掲示準拠（grounded）と断定できず、常に
 * **`general_supplement`** を返す。RAG のフォールバック先として呼ばれる場合も、単体 MVP として
 * 呼ばれる場合も、安全側（ラベル付き一般補足 + 学校固有事実の推測抑止 + 先生誘導）に倒すのが
 * ADR-028 §3 と整合する（「掲示に意味的根拠あり」を未検証の文脈で grounded と誤断定しない）。
 *
 * @param opts.limit grounding 件数上限（既定 6）
 */
export function createPublishedContentProvider(
  opts: PublishedContentProviderOptions = {},
): GroundingProvider {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

  return async (tx: TenantTx, params: { audience: RagAudience }): Promise<GroundingResult> => {
    // 1) 公開中候補（本文を含まない軽量 summary、更新新しい順で決定的）。
    const candidates = await listContents(tx, { status: "published" });

    // 2) 生徒可視 scope に絞り、grounding 件数にクランプ（private を弾いてから limit を消費する）。
    //    class/homeroom の classId 厳密一致は targets が要るため getContentDetail 後に collectActiveContexts
    //    で突合する（listContents は targets を射影しない、#481-2）。ここは scope 種別の粗フィルタに留める。
    const visible = candidates
      .filter((c) => STUDENT_VISIBLE_SCOPES.has(c.publishScope))
      .slice(0, limit);

    // 3) 本文 + 権威的公開状態（activePublish）+ targets を取得。順序を保つため Promise.all で並列取得。
    const details = await Promise.all(visible.map((c) => getContentDetail(tx, c.id)));

    // 4) active publish + audience の class 境界を満たすものだけ採用し ChatContext に整形（順序は visible のまま）。
    // 直接取得は意味的根拠を保証しないため常に general_supplement（ADR-028 §3、安全側）。
    return {
      mode: "general_supplement",
      contexts: collectActiveContexts(details, params.audience),
    };
  };
}

/**
 * `getContentDetail` の結果列から **active publish を持つもの**だけ {@link ChatContext} に整形する。
 * RLS 不可視（別テナント / 不存在）の `null`・unpublish 済 / 下書き（`activePublish === null`）を除外し、
 * 入力配列の順序を保つ。直接取得 / RAG 両 provider で共有する権威的公開状態ゲート。
 */
function collectActiveContexts(
  details: readonly (Awaited<ReturnType<typeof getContentDetail>> | null)[],
  audience: RagAudience,
): ChatContext[] {
  const contexts: ChatContext[] = [];
  for (const detail of details) {
    if (!detail || detail.activePublish === null) continue;
    // audience の class 境界 (#481-2)。RAG 経路は rag-search が SQL で既に絞るため冗長だが、直接取得
    // フォールバック経路ではここが唯一の class ガード（listContents が targets 非射影のため）。
    if (!isVisibleToAudience(detail.content, audience)) continue;
    contexts.push({
      id: detail.content.id,
      title: detail.content.title,
      body: detail.content.body,
    });
  }
  return contexts;
}

/**
 * audience の class 境界で content 1 件の可視性を判定する（#481-2）。school 境界は RLS、公開状態は
 * activePublish が別途保証するため、ここは **scope×class のみ**を見る。
 * - staff: 全 visible scope（`private` は listContents / rag-search が除外済み）。
 * - student + `school`: 無条件可視。
 * - student + `class`/`homeroom`: `targets` に生徒の classId を含むものだけ（classId 無しは不可視）。
 *
 * `normalizeTargets`（visibility.ts）を再利用し、`canStudentSeeContent` の class 突合と単一ソース化する。
 */
function isVisibleToAudience(
  content: { publishScope: string; targets: unknown },
  audience: RagAudience,
): boolean {
  if (audience.kind === "staff") return true;
  if (content.publishScope === "school") return true;
  if (content.publishScope === "class" || content.publishScope === "homeroom") {
    return (
      audience.classId !== null && normalizeTargets(content.targets).includes(audience.classId)
    );
  }
  return false;
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
 *  3. **しきい値フィルタ（ADR-028 §結果, #366）**: 近傍のうち **cosine 類似度 ≥
 *     {@link GROUNDING_SIMILARITY_THRESHOLD}（0.70）** のヒットだけを grounding 候補に残す（弱い類似は
 *     掲示準拠の根拠と見なさない）。`getRelevantPublishedContent` の `similarity = 1 - 距離` で比較するため
 *     方向は正しい（距離で比較すると反転する、{@link GROUNDING_SIMILARITY_THRESHOLD} のコメント参照）。
 *  4. 残ったヒットを `getContentDetail` で本文込み取得し `activePublish !== null` ゲート（権威的公開状態）。
 *  5. 使える context が 1 件以上あれば `mode="grounded"` で返す。0 件なら **MVP 直接取得にフォールバック**し、
 *     その結果を **`mode="general_supplement"`** に倒す（ADR-028 §3、フォールバックは掲示準拠と断定しない）。
 *
 * **フォールバックの意義 + grounding モードの扱い**: embedding 投入バッチ（#365/#398）実行前は
 * `content_versions.embedding` が全 NULL でベクトル検索が 0 件になる。フォールバックで「最近の公開掲示物」を
 * 文脈として渡し、空答弁への退行を防ぐ。ただしフォールバック由来の文脈は **意味的に近いと検証されていない**
 * ため `general_supplement`（ラベル付き一般補足 + 学校固有事実の推測抑止 + 先生誘導）で扱い、grounded と
 * 誤断定しない。バッチ実行後は閾値を満たすヒットが出れば自動で grounded に切り替わる（コード変更不要）。
 *
 * **PII（ルール4）**: embedding には **マスク済み質問のみ** を渡す（生 PII を Vertex embedding へ送らない）。
 * title/body は本 provider ではマスクせず返し、chat-service の fail-closed マスキングに委ねる（MVP と同契約）。
 * **エラー方針**: embedding 生成エラー（次元不一致 / Vertex 障害）は **握り潰さず伝播**（route が SSE error
 * に整形する誠実な失敗）。「embedding 未投入」はエラーでなく 0 件ヒット＝正常系でフォールバックに乗る。
 *
 * @param opts.embeddingClient 質問 embedding クライアント（caller が env から生成して注入）
 * @param opts.limit grounding 件数上限（既定 6）
 */
export function createRagContentProvider(opts: RagContentProviderOptions): GroundingProvider {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const fallback = createPublishedContentProvider({ limit });

  return async (
    tx: TenantTx,
    params: { audience: RagAudience; maskedQuestion: string },
  ): Promise<GroundingResult> => {
    const question = params.maskedQuestion.trim();
    if (question.length > 0) {
      // embedding エラーは握り潰さず伝播（誠実な失敗）。次元検証は embed() / rag-search 双方が行う。
      const [embedding] = await opts.embeddingClient.embed([question]);
      if (embedding) {
        // audience を rag-search に渡し、class/homeroom を生徒の classId で SQL レベル厳密一致 (#481-2)。
        const matches = await getRelevantPublishedContent(tx, embedding, {
          limit,
          audience: params.audience,
        });
        // しきい値（cosine 類似度 ≥ 0.70）を満たすヒットだけを grounding 候補にする。
        const grounded = selectGroundedMatches(matches);
        if (grounded.length > 0) {
          // 本文 + 権威的公開状態を取得（順序保持のため Promise.all、similarity 降順は matches のまま）。
          const details = await Promise.all(grounded.map((m) => getContentDetail(tx, m.contentId)));
          // class 境界は rag-search で SQL 済みだが collectActiveContexts でも再適用（多層防御、#481-2）。
          const contexts = collectActiveContexts(details, params.audience);
          if (contexts.length > 0) return { mode: "grounded", contexts };
        }
      }
    }
    // ベクトル検索 0 件 / 弱い類似のみ / embedding 未投入 / 空質問 → 最近の公開掲示物にフォールバック。
    // フォールバック文脈は意味的根拠未検証ゆえ general_supplement に倒す（fallback provider が既に付与）。
    return fallback(tx, params);
  };
}

/**
 * RAG 近傍 top-k のうち、grounding に採用する（= cosine 類似度 ≥
 * {@link GROUNDING_SIMILARITY_THRESHOLD}）ヒットだけを返す純関数（ADR-028 §結果, #366）。
 *
 * `RagMatch.similarity` は `1 - cosine 距離`（高いほど近い）。**しきい値ちょうど（0.70）は採用**する
 * （`>=`）。距離で比較すると不等号が反転する罠を避けるため必ず similarity で比較する。順序は入力
 * （similarity 降順）を保つ。
 */
export function selectGroundedMatches(matches: readonly RagMatch[]): RagMatch[] {
  return matches.filter((m) => m.similarity >= GROUNDING_SIMILARITY_THRESHOLD);
}
