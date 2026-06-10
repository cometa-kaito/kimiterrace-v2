import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { events } from "../schema/events.js";

/**
 * パターン2 サイネージ盤面の「人感センサカウンタ」用 read 層（F13 / ADR-020）。**SELECT のみ**。
 *
 * 指定クラスの **本日（JST 暦日）の presence イベント件数**（PIR 人感センサーの検知回数）を返す。PIR は
 * 動きの瞬間検知で滞在時間を測れない（ADR-020）ため「在室人数」ではなく「**本日何回検知したか**」の累計を
 * 表示する（2026-06-10 ユーザー確定）。
 *
 * ## クラス帰属（payload.class_id）
 * presence イベントはセンサー webhook（`recordPresenceEvent`）が `sensor_devices` から解決した
 * `class_id` を **`events.payload.class_id`（jsonb）** に焼き込む（events に class_id 列は無い）。よって
 * クラス別件数は `payload->>'class_id' = :classId` で絞る。クラス未割当センサー（class_id=null）は
 * 特定クラスに一致しないので自動的に除外される。
 *
 * ## テナント分離（ルール2）
 * `school_id` 条件を**書かない** — 呼び出し接続の RLS コンテキスト（`app.current_school_id`、ADR-019）が
 * `events` の `tenant_isolation` policy で自校行に絞る。サイネージ経路は `getSignageDisplayData` の
 * `withTenantContext({ schoolId })` 内で呼ぶため、件数も自校スコープになる。手書き WHERE school_id に
 * 依存しない。`db` は非 BYPASSRLS 接続（kimiterrace_app）を使うこと。
 *
 * ## JST 暦日（event-stats.ts と同方針）
 * `occurred_at` を `at time zone 'Asia/Tokyo'` で JST 壁時計に直してから `::date` で暦日へ丸め、引数
 * `jstDate`（YYYY-MM-DD）と一致する行を数える。UTC のまま丸めると深夜帯（JST 8:00 = UTC 前日 23:00）が
 * 前日にずれる。サイネージの `?date=` 上書きにも追従する（盤面の他要素と同じ日付で集計）。
 *
 * ## PII / 監査（ルール4）
 * 返すのは件数（整数）のみ。`payload` の device 詳細は読み出さず、個人別粒度にも落とさない。presence /
 * sensor_devices に PII は無い（ADR-020 §6）。
 */

/** SELECT だけできれば良い（Drizzle db / トランザクションの両方を受ける）。 */
type Selectable = Pick<PostgresJsDatabase, "select">;

/**
 * 指定クラスの本日（JST 暦日 = `jstDate`）の presence 検知件数を返す（RLS で自校スコープ）。
 *
 * @param db      非 BYPASSRLS の Drizzle クライアント / tx（RLS context 下で呼ぶこと）。
 * @param classId 対象クラス（`tv_devices` / magic-link のクラス。`events.payload.class_id` と突合）。
 * @param jstDate 集計対象の JST 暦日（YYYY-MM-DD）。サイネージ表示日と同じ値を渡す。
 * @returns       presence 件数（0 以上の整数）。該当無しは 0。
 */
export async function getTodayPresenceCount(
  db: Selectable,
  classId: string,
  jstDate: string,
): Promise<number> {
  const where = and(
    eq(events.type, "presence"),
    sql`${events.payload} ->> 'class_id' = ${classId}`,
    sql`(${events.occurredAt} at time zone 'Asia/Tokyo')::date = ${jstDate}::date`,
  );
  const count = sql<number>`count(*)`.mapWith(Number);
  const rows = await db.select({ count }).from(events).where(where);
  return rows[0]?.count ?? 0;
}
