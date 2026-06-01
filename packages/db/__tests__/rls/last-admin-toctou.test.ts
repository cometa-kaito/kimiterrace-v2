import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "../../src/client.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F11 / NFR04 (#395 L3, #355 Low-2): last-admin ガード TOCTOU 根治 (#392) の **実 PG 並行テスト**。
 *
 * ## 背景
 * `apps/web/lib/system-admin/users-actions.ts` の無効化 / 降格は、gate (lock 無しの count) を通過した
 * 後に IdP 往復を挟んでから mirror tx で DB を更新する。同一校の最後の 2 名の有効 school_admin を 2 つの
 * system_admin が同時に操作すると、両者とも gate で count=2 を見て通過し「学校が管理者ゼロ」になりうる
 * (#355 Low-2)。根治は mirror tx 内の **`SELECT ... FOR UPDATE` 再カウント**で、READ COMMITTED の
 * EvalPlanQual により先行 tx が commit した無効化済み行を `is_active = true` 条件から除外して数え、
 * 最後の 1 人を直列検出して番兵で tx をロールバックする (ADR-026 / NFR04)。
 *
 * ## このテストの位置づけ
 * #392 の単体テストは mock (`fakeTx` が `lockedAdminCount` を直接返す) で **配線**を pin するが、
 * **FOR UPDATE のブロッキング + EvalPlanQual 再評価という核心の直列化前提そのものは実行されない**。
 * 本テストは `postgres-js` の pool から **複数接続**を引き、`Promise.all` で同時発火させて、PG の行ロックが
 * 実際に「有効 admin を必ず 1 名残す」不変条件を強制することを実 PG で実証する
 * (`cloud-sql-rate-limiter.test.ts` と同じ「真の跨接続並行」戦略)。
 *
 * ## 直列化が決定的である理由 (非 flaky)
 * 全 tx は同一の `WHERE school_id=X AND role='school_admin' AND is_active=true` 行集合を FOR UPDATE で
 * ロックしにいくため必ず競合し、ロック獲得順に直列化される。各 tx は自分の番で再カウントし、count>1 の
 * 間だけ無効化する。ロック解放のたびに EvalPlanQual で無効化済み行が除外されるため、N 件同時でも
 * **ちょうど N-1 件が成功し 1 件が blocked**、有効 admin は常に 1 名残る — どの tx が勝つかに依らず
 * **生存数 = 1 は不変**。`DATABASE_URL` があるときだけ走る (ADR-012)。
 */
describeOrSkip("F11 last-admin TOCTOU 実 PG 並行 (#395 L3, #355 Low-2)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql } = createDbClient(url!);
  let testSchool: string;

  beforeAll(async () => {
    await seedBaseFixture(sql);
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO schools (name, prefecture, code)
      VALUES ('TOCTOU 検証校', '岐阜県', 'T999')
      RETURNING id
    `;
    testSchool = s.id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  /** 対象校の有効 school_admin を n 名だけにリセットして id 配列を返す (BYPASSRLS スーパーユーザー)。 */
  async function freshAdmins(n: number): Promise<string[]> {
    await sql`DELETE FROM users WHERE school_id = ${testSchool}`;
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (school_id, identity_uid, role, display_name, is_active)
        VALUES (${testSchool}, ${`toctou-admin-${i}`}, 'school_admin', ${`管理者 ${i}`}, true)
        RETURNING id
      `;
      ids.push(u.id);
    }
    return ids;
  }

  /** 対象校の有効 school_admin 数 (検証用、BYPASSRLS で実体を数える)。 */
  async function activeAdminCount(): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
      WHERE school_id = ${testSchool} AND role = 'school_admin' AND is_active = true
    `;
    return Number(row.n);
  }

  /**
   * app の last-admin ガード mirror tx を DB レベルで再現する (system_admin context + FOR UPDATE 再カウント)。
   * count<=1 を検出したら UPDATE せず blocked を返す (app の `LastAdminRaceError` 番兵ロールバックに相当)。
   */
  async function attemptGuardedDeactivate(target: string): Promise<"deactivated" | "blocked"> {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const locked = await tx`
        SELECT id FROM users
        WHERE school_id = ${testSchool} AND role = 'school_admin' AND is_active = true
        FOR UPDATE
      `;
      if (locked.length <= 1) {
        return "blocked" as const;
      }
      await tx`UPDATE users SET is_active = false, updated_at = now() WHERE id = ${target}`;
      return "deactivated" as const;
    });
  }

  it("(逐次) 最後の 1 名の無効化は guard で blocked、有効 admin が 1 名残る (ガード自体の健全性)", async () => {
    const [a, b] = await freshAdmins(2);
    expect(await attemptGuardedDeactivate(a)).toBe("deactivated"); // 2 → 1
    expect(await attemptGuardedDeactivate(b)).toBe("blocked"); // 1 名のため拒否
    expect(await activeAdminCount()).toBe(1);
  });

  it("(跨接続) 最後の 2 名を 2 接続で同時無効化 → FOR UPDATE 直列化で 1 名だけ成功、有効 admin が 1 名残る", async () => {
    const [a, b] = await freshAdmins(2);
    const results = await Promise.all([attemptGuardedDeactivate(a), attemptGuardedDeactivate(b)]);
    expect(results.filter((r) => r === "deactivated").length).toBe(1);
    expect(results.filter((r) => r === "blocked").length).toBe(1);
    // 核心の不変条件: 学校が「管理者ゼロ」にならない。
    expect(await activeAdminCount()).toBe(1);
  });

  it("(跨接続) N=5 を全接続で同時無効化しても有効 admin は必ず 1 名残る (直列化の不変条件)", async () => {
    const ids = await freshAdmins(5);
    const results = await Promise.all(ids.map((id) => attemptGuardedDeactivate(id)));
    expect(results.filter((r) => r === "deactivated").length).toBe(4);
    expect(results.filter((r) => r === "blocked").length).toBe(1);
    expect(await activeAdminCount()).toBe(1);
  });
});
