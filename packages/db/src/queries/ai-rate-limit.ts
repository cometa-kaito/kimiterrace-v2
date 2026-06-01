import type { RateLimitStore } from "@kimiterrace/ai";
import { sql } from "drizzle-orm";
import { type KimiterraceDb, type WithTenantContextOptions, withTenantContext } from "../client.js";

/**
 * F03 (#348, ADR-027): 分散レート制限の **Cloud SQL カウンタ行 store**。
 *
 * `packages/ai` の `RateLimitStore` 契約を実装し、`DistributedRateLimiter` から呼ばれる。
 * `INSERT ... ON CONFLICT (school_id, window_start_ms) DO UPDATE SET count = count+1 WHERE count < $limit RETURNING count`
 * を 1 文で発行することで、複数 Cloud Run インスタンスが同 school へ並列発火しても
 * **DB の行レベルロックで直列化** + **WHERE 句で limit 超過を構造排除**する (ADR-027 §SQL 契約)。
 *
 * 受け入れ基準 (#348):
 *   - 実 PG で **跨接続** Promise.all 並行アクセスでも 60 req/60s/school の上限が守られる
 *     (FakeAtomicStore では未実証だった「真の並行」を本実装で固定)。
 *
 * 不変条件:
 *   - `withTenantContext({ schoolId: key })` 内で実行: `tenant_isolation` policy
 *     (migration 0013) が school 越境 INSERT/UPDATE を WITH CHECK で弾く
 *     (CLAUDE.md ルール2、ADR-019)。WHERE school_id を手書きしない。
 *   - SELECT-then-UPDATE は行わない。RETURNING の行数で allow/deny を判定する
 *     (TOCTOU を構造排除、ADR-027)。
 *   - `app.current_user_id` は **未設定でも RLS は通る** (本テーブルの policy は school_id のみ)。
 *     監査 4 列 (created_by/updated_by) は null 許容 = システム実行扱い (CLAUDE.md ルール1)。
 *
 * 呼び出し側 (`structureContent`) は `RateLimiter` インターフェイス越しに使うため、
 * 本 store の差し替えは透過 (依存逆転維持、PR #345 で確立)。
 */
export class CloudSqlRateLimiter implements RateLimitStore {
  /**
   * @param db        非 BYPASSRLS ロールで接続した Drizzle クライアント
   *                  (本番は最初から `kimiterrace_app` 接続。テストは options.appRole で降格)
   * @param options   `withTenantContext` に渡す追加オプション (テスト時の SET LOCAL ROLE 等)
   */
  constructor(
    private readonly db: KimiterraceDb,
    private readonly options: WithTenantContextOptions = {},
  ) {}

  async tryAcquireSlot(key: string, windowStartMs: number, limit: number): Promise<boolean> {
    // school_id を RLS context に張る。policy は school_id のみ参照するため role/user は不要
    // (deny-by-default は schoolId 未設定で発火する: ルール2)。
    return await withTenantContext(
      this.db,
      { schoolId: key },
      async (tx) => {
        // ADR-027 §SQL 契約: WHERE count < $limit を満たすときだけ count+=1 して RETURNING。
        // 行返却 = allow / 0 行 = deny。同一 (school_id, window_start_ms) への並行 UPSERT は
        // PG の行レベルロックで直列化されるため、N 並列でも limit 超過は起きない。
        const rows = await tx.execute<{ count: number }>(sql`
          INSERT INTO ai_rate_limit_windows (school_id, window_start_ms, count)
          VALUES (${key}::uuid, ${windowStartMs}, 1)
          ON CONFLICT (school_id, window_start_ms) DO UPDATE
            SET count = ai_rate_limit_windows.count + 1, updated_at = now()
            WHERE ai_rate_limit_windows.count < ${limit}
          RETURNING count
        `);
        return rows.length > 0;
      },
      this.options,
    );
  }
}
