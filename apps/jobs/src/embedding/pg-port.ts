import {
  type KimiterraceDb,
  type TenantContext,
  listPendingEmbeddings,
  saveContentEmbedding,
  withTenantContext,
} from "@kimiterrace/db";
import type { EmbeddingBatchPort, PendingVersion } from "./embed-content.js";

/**
 * F06 (#398, ADR-007 / CLAUDE.md ルール2,4): `EmbeddingBatchPort` の実 PG / RLS アダプタ。
 *
 * `embedPendingContent` (#394) が依存逆転で要求する DB I/O を、`@kimiterrace/db` のクエリ層
 * (`listPendingEmbeddings` / `saveContentEmbedding`、#398) に `withTenantContext` を張って委ねる。
 *
 * 設計上の規律:
 * - **1 ポート = 1 校スコープ (ルール2)**: コンストラクタで受けた `ctx` (school_admin 降格 +
 *   `app.current_school_id`) を全 I/O に張る。全校横断ドライバ (#398 次スライス) が `system_admin`
 *   で school を列挙し、校ごとに本アダプタ + 名簿を生成する。BYPASSRLS は使わない。
 * - **操作ごとにトランザクションを張る (1 op = 1 tx)**: `listPending` / `saveEmbedding` を 1 本の
 *   長い tx に束ねない。`embedPendingContent` は listPending → (Vertex embed) → saveEmbedding の
 *   順で **Vertex のネットワーク往復を挟む**ため、束ねるとプール接続と行ロックを往復の間ずっと
 *   保持してしまう。op ごとに短い tx を張ることで接続を即返し、かつ各 saveEmbedding が独立コミット
 *   される → 途中失敗しても確定済み embedding は `listPending` の `embedding IS NULL` 条件で再走査
 *   から外れ、再実行が冪等に再開できる (#398 設計判断5 resume の素地)。
 * - **越境書込みの遮断 (ルール2)**: `saveContentEmbedding` の戻り (影響行数) が 1 でなければ throw。
 *   RLS USING が他校行を不可視にするため、スコープ外 version への保存は 0 行になる。これを成功と
 *   見なすと「保存したつもりで未保存」になり RAG が静かに欠落するため、明示的に失敗させる。
 */

export interface PgEmbeddingPortOptions {
  /**
   * 接続が BYPASSRLS な特権ロール (テスト superuser 等) のとき、tx 内でアプリロールへ降格する先。
   * 本番は最初から `kimiterrace_app` で接続するため未指定でよい (withTenantContext と同契約)。
   */
  appRole?: string;
}

/**
 * 1 校スコープの `EmbeddingBatchPort` を生成する。
 *
 * @param db      非 BYPASSRLS ロールで接続した Drizzle クライアント (本番は `kimiterrace_app`)
 * @param ctx     校スコープのテナントコンテキスト (`schoolId` + `role`。未設定キーは deny-by-default)
 * @param options `appRole` 指定時は各 tx で `SET LOCAL ROLE` 降格
 */
export function createPgEmbeddingPort(
  db: KimiterraceDb,
  ctx: TenantContext,
  options: PgEmbeddingPortOptions = {},
): EmbeddingBatchPort {
  const { appRole } = options;
  const wtcOptions = appRole !== undefined ? { appRole } : {};

  return {
    async listPending(): Promise<PendingVersion[]> {
      // PendingEmbedding ({versionId, snapshot}) は PendingVersion と構造同型。
      return await withTenantContext(db, ctx, (tx) => listPendingEmbeddings(tx), wtcOptions);
    },

    async saveEmbedding(versionId: string, embedding: number[]): Promise<void> {
      const affected = await withTenantContext(
        db,
        ctx,
        (tx) => saveContentEmbedding(tx, versionId, embedding),
        wtcOptions,
      );
      if (affected !== 1) {
        throw new Error(
          `createPgEmbeddingPort.saveEmbedding: 期待 1 行に対し ${affected} 行更新 ` +
            `(version=${versionId})。RLS スコープ外 / version 不在の可能性。`,
        );
      }
    },
  };
}
