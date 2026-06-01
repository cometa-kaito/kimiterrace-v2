import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { auditColumns } from "../_shared/audit.js";
import { schools } from "./schools.js";

/**
 * F03 (#155-B-1 / ADR-027): 分散レート制限の Cloud SQL カウンタ行。
 *
 * 旧 `FixedWindowRateLimiter` (packages/ai/src/rate-limit.ts) は単一プロセス内のみ正確で、
 * Cloud Run の複数インスタンスを跨ぐと最悪 `60 × N` req/min が Vertex に流れる。本テーブルは
 * `INSERT ... ON CONFLICT DO UPDATE SET count = count+1 WHERE count < $limit RETURNING count`
 * を 1 文で原子的に発行することで、N 並列でも school 単位の上限を DB レベルで保証する
 * (ADR-027 の SQL 契約)。
 *
 * - 一意制約 (school_id, window_start_ms) で同一ウィンドウ行を 1 行に集約 (UPSERT のキー)。
 * - `window_start_ms` は epoch ms / windowMs を切り捨てた整数。bigint で 2262 年まで安全。
 * - RLS + tenant_isolation でテナント越境を構造排除 (ルール2、ADR-019)。
 * - 監査4列を auditColumns で付与 (ルール1、CLAUDE.md)。
 * - 古いウィンドウ行は日次 cron で `DELETE WHERE window_start_ms < (now - 1day)` する想定 (ADR-027)。
 *
 * 関連: ADR-027, #155, PR #345 (抽象 + ADR), #348 (後続: PostgresRateLimitStore + 結合テスト)。
 */
export const aiRateLimitWindows = pgTable(
  "ai_rate_limit_windows",
  {
    schoolId: uuid("school_id")
      .notNull()
      .references(() => schools.id, { onDelete: "cascade" }),
    // 固定ウィンドウ開始時刻 (epoch ms、windowMs を切り捨て)。bigint で 2262 年まで安全。
    windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(0),
    ...auditColumns,
  },
  (t) => ({
    pk: primaryKey({ columns: [t.schoolId, t.windowStartMs] }),
    // count は単調増加カウンタ。負値は upsert ロジックの不変条件違反。
    ckCountNonNegative: check("ck_ai_rate_limit_windows_count_nonneg", sql`${t.count} >= 0`),
  }),
);
