import {
  type KimiterraceDb,
  listPendingEmbeddingVersions,
  saveContentEmbedding,
  withTenantContext,
} from "@kimiterrace/db";
import type { EmbeddingBatchPort } from "./embed-content.js";

/**
 * F06 (#398, ADR-007 / CLAUDE.md ルール2): {@link EmbeddingBatchPort} の実 PG/RLS アダプタ。
 *
 * 1 インスタンス = 1 校スコープ。`listPending` / `saveEmbedding` はそれぞれ
 * `withTenantContext({ role: "school_admin", schoolId }, …, { appRole: "kimiterrace_app" })` で
 * **非 BYPASSRLS ロール**の短いトランザクションを開き、DB クエリ本体（packages/db の
 * {@link listPendingEmbeddingVersions} / {@link saveContentEmbedding}）に委譲する薄いラッパー。
 *
 * - **テナント分離 (ルール2)**: クエリ層は `school_id` を書かず、ここで張る RLS context（school_admin
 *   への降格 = `system_admin_full_access` 非該当 → `tenant_isolation` のみ）が自校行に限定する。
 *   越境読込/書込は DB レベルで 0 行に倒れる（実 PG 結合テストは packages/db/__tests__/rls）。
 * - **トランザクション境界**: 低速な Vertex 呼び出し（embedPendingContent 内）は tx の外で起きる。
 *   listPending（1 回）と saveEmbedding（件数分）をそれぞれ短い tx に分け、DB tx を Vertex 往復の
 *   間ずっと保持しない。
 * - 全校横断はドライバ（run-batch.ts）が system_admin で school を列挙し、校ごとに本アダプタ + roster を
 *   生成する（BYPASSRLS 不使用）。
 */

/** 本アダプタが SET LOCAL ROLE で降格するアプリロール（非 BYPASSRLS、RLS を実際に効かせる）。 */
const APP_ROLE = "kimiterrace_app";

/**
 * 1 校スコープの実 PG/RLS embedding ポートを生成する。
 *
 * @param db        非 BYPASSRLS ロールで接続した Drizzle クライアント（本アダプタが SET LOCAL ROLE で降格）
 * @param schoolId  対象校。RLS の `app.current_school_id` に設定され、可視/書込範囲をこの校に限定する
 */
export function createPgEmbeddingPort(db: KimiterraceDb, schoolId: string): EmbeddingBatchPort {
  const ctx = { schoolId, role: "school_admin" as const };
  const options = { appRole: APP_ROLE };

  return {
    listPending() {
      return withTenantContext(db, ctx, (tx) => listPendingEmbeddingVersions(tx), options);
    },
    saveEmbedding(versionId: string, embedding: number[]): Promise<void> {
      return withTenantContext(
        db,
        ctx,
        async (tx) => {
          await saveContentEmbedding(tx, versionId, embedding);
        },
        options,
      );
    },
  };
}
