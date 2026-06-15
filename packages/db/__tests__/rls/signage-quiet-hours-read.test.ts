import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClassConfigValue } from "../../src/queries/school-configs.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #191: サイネージの**匿名コンテキスト**で `school_configs` (scope=class, kind='quiet_hours') を
 * 読めることを実 PG + RLS で検証する。
 *
 * サイネージ端末は教員セッションを持たない匿名アクセスで、token 解決後に
 * `withTenantContext(db, { schoolId })` だけで tx を開く ─ すなわち `app.current_school_id` のみ
 * set し、`app.current_user_role` / `app.current_user_id` は **set しない** (deny-by-default、
 * apps/web/lib/signage/signage-display.ts 参照)。
 *
 * `school_configs` の `tenant_isolation` policy (migration 0006) は `daily_data` と同一で
 * **school_id 一致のみ・ロール非依存**。よってサイネージ既存の daily_data 読み取りと同じ経路で
 * school_configs も読める ─ 新規 policy / SECURITY DEFINER は不要 (CLAUDE.md ルール2)。本テストは
 * その前提を実証し、回帰 (policy 強化でサイネージが読めなくなる等) を検知する。
 *
 * - 自校の匿名コンテキスト → クラス既定 quiet_hours が読める。
 * - 他校の匿名コンテキスト → 不可視 (テナント分離、null)。
 * - context 未設定 (school_id すら無し) → deny-by-default で不可視。
 */
describeOrSkip(
  "RLS: サイネージ匿名コンテキストでの school_configs quiet_hours 読み取り (#191)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const sql = createSql(url!);
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
    let classA1: string;
    const ranges = { ranges: [{ start: "12:00", end: "13:00" }] };

    /**
     * サイネージの匿名 RLS context を張った max:1 接続で fn を実行する。
     * `withTenantContext({ schoolId })` 相当 — **school_id のみ** set し role/userId は載せない。
     */
    async function asSignageAnon<T>(
      schoolId: string | null,
      fn: (db: ReturnType<typeof drizzle>) => Promise<T>,
    ) {
      // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
      const client = postgres(url!, { max: 1, onnotice: () => {} });
      try {
        const db = drizzle(client);
        await client.unsafe("SET ROLE kimiterrace_app");
        if (schoolId) {
          await client`SELECT set_config('app.current_school_id', ${schoolId}, false)`;
        }
        // role / userId は意図的に set しない (匿名 = deny-by-default)。
        return await fn(db);
      } finally {
        await client.unsafe("RESET ROLE").catch(() => {});
        await client.end({ timeout: 5 });
      }
    }

    beforeAll(async () => {
      fx = await seedBaseFixture(sql);

      // school A にクラスを 1 件 (BYPASSRLS = テーブル所有者接続で投入)。
      classA1 = (
        await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, name, grade)
        VALUES (${fx.schoolA}, '1-A', 1) RETURNING id
      `
      )[0].id;

      // school A の class スコープ quiet_hours 既定を投入 (school_configs)。
      await sql`
      INSERT INTO school_configs (school_id, scope, class_id, kind, value)
      VALUES (${fx.schoolA}, 'class', ${classA1}, 'quiet_hours', ${sql.json(ranges)})
    `;
    });

    afterAll(async () => {
      await sql.end({ timeout: 5 });
    });

    it("自校の匿名コンテキストでクラス quiet_hours 既定が読める (school_id のみで可視)", async () => {
      const value = await asSignageAnon(fx.schoolA, (db) =>
        getClassConfigValue(db as never, classA1, "quiet_hours"),
      );
      expect(value).toEqual(ranges);
    });

    it("RLS: 他校 (school B) の匿名コンテキストでは A のクラス設定が不可視 (テナント分離)", async () => {
      const value = await asSignageAnon(fx.schoolB, (db) =>
        getClassConfigValue(db as never, classA1, "quiet_hours"),
      );
      expect(value).toBeNull();
    });

    it("context 未設定 (school_id 無し) は deny-by-default で不可視", async () => {
      const value = await asSignageAnon(null, (db) =>
        getClassConfigValue(db as never, classA1, "quiet_hours"),
      );
      expect(value).toBeNull();
    });
  },
);
