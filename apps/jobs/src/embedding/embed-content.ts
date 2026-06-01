import {
  type EmbeddingClient,
  type MaskOptions,
  type PiiEntry,
  findUnmaskedPii,
  maskPII,
} from "@kimiterrace/ai";
import { snapshotToEmbeddingText } from "./text.js";

/**
 * F06 (#365, ADR-007 / CLAUDE.md ルール4): 公開中 content の embedding 生成バッチ（本体ロジック）。
 *
 * **公開コンテンツを 1 校スコープで走査し、PII マスキング後テキストから embedding を生成して保存する。**
 * DB / RLS の具体は `EmbeddingBatchPort`（依存逆転のポート）、Vertex 呼び出しは `EmbeddingClient` に委ね、
 * 本関数はマスキング順序・空テキスト除外・バッチ分割という「壊れると漏れる／壊れると非効率になる」
 * ロジックだけを持つ。これによりフェイクで GCP/PG なしに単体検証できる（ADR-012、`model/client.ts` 同様）。
 *
 * 1 ポートインスタンス = 1 校スコープ（RLS context を張った接続）。全校横断はドライバ（#365-b）が
 * `system_admin` で school を列挙し、校ごとにポート + 名簿を生成して本関数を呼ぶ（BYPASSRLS 不使用、
 * ルール2）。校ごとに名簿（`maskEntries`）が異なるため、本体は 1 校分を受け取る設計にしている。
 *
 * 不変条件:
 * - **マスキング → embedding 生成の順序を厳守**（生 PII を Vertex へ送らない、ルール4）。
 * - 埋め込みテキストが空（title/body 無し）の version は対象外（skip、embedding 生成しない）。
 * - `batchSize` ごとに `embed` でまとめて生成し API 往復を抑える。
 */

/** embedding 未生成かつ公開中の content_version（ポートが RLS スコープで抽出済）。 */
export interface PendingVersion {
  versionId: string;
  /** content_versions.snapshot（jsonb 任意形）。title/body を埋め込む。 */
  snapshot: unknown;
}

/**
 * バッチが DB に対して行う最小 I/O（依存逆転のポート）。実アダプタ（withTenantContext + drizzle、
 * `system_admin` での school 列挙）と実 PG 結合テストは #365-b。本体はフェイクで検証する。
 */
export interface EmbeddingBatchPort {
  /** 公開中（active publish）かつ `embedding IS NULL` の content_versions を返す（RLS スコープ済）。 */
  listPending(): Promise<PendingVersion[]>;
  /** 1 件の embedding を保存する（UPDATE で `updated_at` を明示更新すること、ルール1）。 */
  saveEmbedding(versionId: string, embedding: number[]): Promise<void>;
}

export interface EmbedPendingOptions {
  /** 1 回の `embed` 呼び出しに渡す最大件数（既定 32、1 以上にクランプ）。 */
  batchSize?: number;
  /**
   * この校の名簿（生徒/保護者/職員氏名）。氏名の確定マスク用（ルール4）。既定は空配列で、
   * `maskPII` の電話・メール正規表現検出のみが効く。氏名マスクが要る掲示物本文ではドライバが
   * 校スコープの roster を渡す。
   */
  maskEntries?: readonly PiiEntry[];
  /**
   * `maskPII` のパターン検出 ON/OFF（structure.ts と対称）。**本番は既定（電話・メール検出 ON）で
   * 呼ぶこと** — 掲示物本文は常にマスク全開が正しい。検出を弱めても下流の `findUnmaskedPii` ゲートが
   * 残存 PII を捕捉して当該 version を embedding 対象から外す（fail-closed）ため、誤設定が生 PII の
   * Vertex 送信・永続にはつながらない。
   */
  maskOptions?: MaskOptions;
}

export interface EmbedPendingResult {
  /** ポートが返した embedding 未生成 version 数。 */
  scanned: number;
  /** 実際に embedding を生成・保存した件数。 */
  embedded: number;
  /** 埋め込みテキストが空で skip した件数。 */
  skippedEmptyText: number;
  /**
   * マスキング後も PII 形跡が残ったため Vertex へ送らず skip した件数（fail-closed、ルール4）。
   * 0 が正常。非 0 は roster 欠落 / 新しい PII 書式の兆候で、運用上は調査対象（#394 Reviewer L3）。
   */
  blockedUnmaskedPii: number;
}

/**
 * 1 校スコープの公開中・embedding 未生成 content_versions を走査し、PII マスキング後テキストから
 * embedding を生成して保存する。
 */
export async function embedPendingContent(
  port: EmbeddingBatchPort,
  client: EmbeddingClient,
  options: EmbedPendingOptions = {},
): Promise<EmbedPendingResult> {
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? 32));
  const maskEntries = options.maskEntries ?? [];
  const pending = await port.listPending();

  // マスキング後テキストを作り、空テキスト（埋め込み対象なし）は除外する。
  // ルール4: ここで maskPII を通すことで、以降 client.embed へ渡るのは必ずマスク済みテキスト。
  const targets: { versionId: string; masked: string }[] = [];
  let skippedEmptyText = 0;
  let blockedUnmaskedPii = 0;
  for (const v of pending) {
    const text = snapshotToEmbeddingText(v.snapshot);
    if (text.length === 0) {
      skippedEmptyText += 1;
      continue;
    }
    const masked = maskPII(text, maskEntries, options.maskOptions ?? {}).masked;
    // 多層防御（ルール4、#394 Reviewer L3）: embedding は永続するため、マスク後にも検出可能な PII
    // （roster 漏れの氏名・未対応書式の電話/メール）が残る version は **Vertex へ送らず skip** する
    // （fail-closed）。生成バッチ全体を 1 件で止めず、件数だけ記録して運用が調査できるようにする。
    if (findUnmaskedPii(masked, maskEntries).length > 0) {
      blockedUnmaskedPii += 1;
      continue;
    }
    targets.push({ versionId: v.versionId, masked });
  }

  let embedded = 0;
  for (let i = 0; i < targets.length; i += batchSize) {
    const chunk = targets.slice(i, i + batchSize);
    const embeddings = await client.embed(chunk.map((t) => t.masked));
    if (embeddings.length !== chunk.length) {
      throw new Error(
        `embedPendingContent: embedding 数がチャンクと不一致 (${embeddings.length} != ${chunk.length})`,
      );
    }
    for (let j = 0; j < chunk.length; j += 1) {
      const target = chunk[j];
      const embedding = embeddings[j];
      // 直前に長さ一致を検証済。型（noUncheckedIndexedAccess）の都合で undefined を弾く（不到達）。
      if (target === undefined || embedding === undefined) {
        throw new Error("embedPendingContent: 内部不整合 (chunk/embeddings の index ずれ)");
      }
      await port.saveEmbedding(target.versionId, embedding);
      embedded += 1;
    }
  }

  return { scanned: pending.length, embedded, skippedEmptyText, blockedUnmaskedPii };
}
