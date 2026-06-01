import {
  type KimiterraceDb,
  type TenantRole,
  listPendingEmbeddingVersions,
  saveContentEmbedding,
  withTenantContext,
} from "@kimiterrace/db";
import type { EmbeddingBatchPort } from "./embed-content.js";

/**
 * F06 (#398, #365 follow-up): `EmbeddingBatchPort` の実 PG / RLS アダプタ。
 *
 * 1 ポートインスタンス = 1 校スコープ。各メソッドは `withTenantContext` で **school_admin に降格した**
 * RLS context (school_id + role) を張った短いトランザクション内で query 層 (packages/db) を呼ぶ
 * (BYPASSRLS 不使用、ルール2)。`system_admin` を使うと `system_admin_full_access` policy が全校
 * PERMISSIVE に発火し越境するため、必ず school_admin で叩く (校列挙ドライバが system_admin で
 * schools を引き、校ごとに本ポートを生成する: #398 第2スライス)。
 *
 * **tx を跨がない設計**: `embedPendingContent` は `listPending()` → (Vertex 呼び出し) →
 * `saveEmbedding()` の順で進む。listPending と saveEmbedding を 1 つの長い tx にすると Vertex の
 * ネットワーク往復の間 PG ロック/接続を保持してしまうため、メソッドごとに独立した短い tx にする。
 * RLS context は tx ローカル (`SET LOCAL`) なので毎回張り直す。
 *
 * RLS 密結合 SQL 本体と実 PG テナント分離テストは packages/db 側
 * (`queries/embedding-batch.ts` / `__tests__/rls/embedding-batch.test.ts`)。本ラッパは context の
 * 張り方だけを担い、ユニットテストで配線を pin する。
 */

export type PgEmbeddingPortConfig = {
  /** 非 BYPASSRLS ロールで接続した Drizzle クライアント (本番は `kimiterrace_app`)。 */
  db: KimiterraceDb;
  /** この校の school_id。RLS スコープを張る。 */
  schoolId: string;
  /**
   * BYPASSRLS な接続 (テスト superuser 等) をアプリロールへ降格する `SET LOCAL ROLE` 先。
   * 本番は最初から `kimiterrace_app` 接続のため未指定。
   */
  appRole?: string;
};

export function createPgEmbeddingPort(config: PgEmbeddingPortConfig): EmbeddingBatchPort {
  const { db, schoolId, appRole } = config;
  // 校スコープの RLS context。system_admin ではなく school_admin で RLS を実際に効かせる (ルール2)。
  const ctx = { schoolId, role: "school_admin" satisfies TenantRole as TenantRole };
  const options = appRole !== undefined ? { appRole } : {};

  return {
    listPending() {
      return withTenantContext(db, ctx, (tx) => listPendingEmbeddingVersions(tx), options);
    },
    async saveEmbedding(versionId, embedding) {
      await withTenantContext(
        db,
        ctx,
        (tx) => saveContentEmbedding(tx, versionId, embedding),
        options,
      );
    },
  };
}
