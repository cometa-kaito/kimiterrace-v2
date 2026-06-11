import { type InferSelectModel, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TenantTx } from "../client.js";
import { railwayStatus } from "../schema/railway-status.js";

/**
 * パターン2「鉄道」の運行情報キャッシュ query 層（ADR-035）。weather_forecasts と同じ閉域パターン:
 * 取得 Job が **system context で upsert**、サイネージは **匿名コンテキストで read**（`railway_status_read_all`
 * USING(true)）。手書き WHERE school_id は書かない（school_id 非保持の公開・非 PII テーブル、ADR-019 特例）。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;
type RailwayStatusRow = InferSelectModel<typeof railwayStatus>;
export type RailwayStatus = RailwayStatusRow;

/** 取得 Job が upsert する入力（運行情報の現況）。空欄は null。 */
export type UpsertRailwayStatusInput = {
  operator: string;
  operatorName: string | null;
  hasDisruption: boolean;
  statusText: string;
  sourceUrl: string | null;
  /** 取得時刻（未指定は now()）。 */
  fetchedAt?: Date;
};

/**
 * 事業者の運行情報を upsert する（ON CONFLICT operator）。**system context（取得 Job）で呼ぶ**
 * （`railway_status_write_system` が role=system_admin を要求）。再取得時は fetchedAt / updatedAt を進める。
 */
export async function upsertRailwayStatus(
  tx: TenantTx,
  input: UpsertRailwayStatusInput,
): Promise<string> {
  const rows = await tx
    .insert(railwayStatus)
    .values({
      operator: input.operator,
      operatorName: input.operatorName,
      hasDisruption: input.hasDisruption,
      statusText: input.statusText,
      sourceUrl: input.sourceUrl,
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
      createdBy: null,
      updatedBy: null,
    })
    .onConflictDoUpdate({
      target: railwayStatus.operator,
      set: {
        operatorName: input.operatorName,
        hasDisruption: input.hasDisruption,
        statusText: input.statusText,
        sourceUrl: input.sourceUrl,
        fetchedAt: input.fetchedAt ?? new Date(),
        // ルール1: 再取得時刻として updated_at を明示更新（created_at / created_by は初回値を保つ）。
        updatedAt: new Date(),
        updatedBy: null,
      },
    })
    .returning({ id: railwayStatus.id });
  const id = rows[0]?.id;
  if (!id) {
    throw new Error("upsertRailwayStatus: INSERT ... RETURNING が行を返しませんでした");
  }
  return id;
}

/**
 * 指定事業者の現況 1 行を返す（無ければ null）。サイネージ匿名コンテキスト（role 未設定）でも
 * `railway_status_read_all`（USING true）により読める。
 *
 * @param db       SELECT 可能な接続 / tx（匿名サイネージは school_id のみ or 無しで可）。
 * @param operator 事業者コード（例 'meitetsu'）。
 */
export async function getRailwayStatus(
  db: Selectable,
  operator: string,
): Promise<RailwayStatus | null> {
  const rows = await db
    .select()
    .from(railwayStatus)
    .where(eq(railwayStatus.operator, operator))
    .limit(1);
  return rows[0] ?? null;
}
