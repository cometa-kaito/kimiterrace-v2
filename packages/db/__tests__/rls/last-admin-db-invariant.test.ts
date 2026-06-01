import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient } from "../../src/client.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F11 / NFR04 (#395 L2, ADR-026 L2 "preferred"): 「各校に有効な (is_active) school_admin >= 1」を
 * **DB レベルの不変条件**として強制するトリガ (migration 0015) の実 PG テスト。
 *
 * ## L3 (last-admin-toctou.test.ts) との違い = この多層防御の核心
 * L3 は **アプリ層ガードを DB で再現** (`SELECT ... FOR UPDATE` 再カウント) して、seam を通る経路の
 * 直列化を実証した。本テストは逆に、**アプリ層ガードを一切通さず生 UPDATE / DELETE を直接投げる**
 * (= seam をバイパスする経路: 直 SQL / 将来の別エンドポイント / バッチ)。それでもトリガ単独で
 * 「学校が管理者ゼロ」を拒否することを実証する。ADR-026 L2 が "preferred" とした defense-in-depth。
 *
 * ## 直列化が決定的である理由 (非 flaky)
 * トリガはガード対象の除去遷移で school 単位の `pg_advisory_xact_lock` を取ってから「OLD を除いて残る
 * 有効 school_admin」を数える。並行する複数の除去は同一 advisory key で必ず競合しロック獲得順に直列化
 * され、後続 tx はロック解放後に新スナップショット (READ COMMITTED) で再カウントするため先行 tx の commit を
 * 反映する。N 件同時でも **ちょうど N-1 件が成功し 1 件が KT001 で blocked**、有効 admin は常に 1 名残る —
 * どの tx が勝つかに依らず **生存数 = 1 は不変**。`DATABASE_URL` があるときだけ走る (ADR-012)。
 *
 * ## vacuous でない担保
 * 「最後の 1 名は拒否」だけだと「常に拒否するトリガ」でもパスしてしまう。そこで「2 名なら 1 名目の除去は
 * 通る」逐次サニティ、teacher / 再有効化 / 昇格は通る正例、BYPASSRLS 独立 count を併置して、トリガが
 * **除去遷移のみ・最後の 1 名のみ**を弾くことを両側から固定する。
 */
describeOrSkip("F11 last-admin DB 不変条件トリガ 実 PG (#395 L2, ADR-026 L2)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql } = createDbClient(url!);
  let testSchool: string;

  beforeAll(async () => {
    await seedBaseFixture(sql);
    const [s] = await sql<{ id: string }[]>`
      INSERT INTO schools (name, prefecture, code)
      VALUES ('L2 トリガ検証校', '岐阜県', 'T998')
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

  /**
   * 対象校を「有効 school_admin n 名」に正規化して id 配列を返す (BYPASSRLS スーパーユーザー)。
   * 0015 のトリガが「最後の有効 school_admin の DELETE」を弾くため、arrange の一括 DELETE 中だけ
   * トリガを無効化する (seedBaseFixture が audit トリガを止めるのと同じ規律)。act では再び有効。
   * INSERT はトリガ対象外 (BEFORE UPDATE/DELETE のみ) なので囲む必要はない。
   */
  async function freshAdmins(n: number): Promise<string[]> {
    await sql.unsafe("ALTER TABLE users DISABLE TRIGGER trg_enforce_school_has_active_admin");
    try {
      await sql`DELETE FROM users WHERE school_id = ${testSchool}`;
    } finally {
      await sql.unsafe("ALTER TABLE users ENABLE TRIGGER trg_enforce_school_has_active_admin");
    }
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (school_id, identity_uid, role, display_name, is_active)
        VALUES (${testSchool}, ${`l2-admin-${i}`}, 'school_admin', ${`管理者 ${i}`}, true)
        RETURNING id
      `;
      ids.push(u.id);
    }
    return ids;
  }

  /** 任意ロールの user を 1 名追加して id を返す (INSERT はトリガ対象外)。 */
  async function addUser(role: string, uid: string): Promise<string> {
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (school_id, identity_uid, role, display_name, is_active)
      VALUES (${testSchool}, ${uid}, ${role}::user_role, ${uid}, true)
      RETURNING id
    `;
    return u.id;
  }

  /** 対象校の有効 school_admin 数 (検証用、BYPASSRLS で実体を数える)。 */
  async function activeAdminCount(): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users
      WHERE school_id = ${testSchool} AND role = 'school_admin' AND is_active = true
    `;
    return Number(row.n);
  }

  type RawAction = "deactivate" | "reactivate" | "demote" | "promote" | "delete";

  /**
   * アプリ層ガード (FOR UPDATE 再カウント) を**通さず**、生のミューテーションを system_admin context で
   * 直接実行する。トリガが KT001 で弾けば "blocked"、通れば "ok"。RLS も実際に効かせる
   * (`kimiterrace_app` + system_admin context)。生 postgres クライアントなので SQLSTATE は `.code` に直接乗る。
   */
  async function runRaw(action: RawAction, id: string): Promise<"ok" | "blocked"> {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
        switch (action) {
          case "deactivate":
            await tx`UPDATE users SET is_active = false, updated_at = now() WHERE id = ${id}`;
            break;
          case "reactivate":
            await tx`UPDATE users SET is_active = true, updated_at = now() WHERE id = ${id}`;
            break;
          case "demote":
            await tx`UPDATE users SET role = 'teacher', updated_at = now() WHERE id = ${id}`;
            break;
          case "promote":
            await tx`UPDATE users SET role = 'school_admin', updated_at = now() WHERE id = ${id}`;
            break;
          case "delete":
            await tx`DELETE FROM users WHERE id = ${id}`;
            break;
        }
      });
      return "ok";
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string } };
      if (err?.code === "KT001" || err?.cause?.code === "KT001") {
        return "blocked";
      }
      throw e;
    }
  }

  // ---- 逐次サニティ (vacuous でない: 除去遷移のみ・最後の 1 名のみ弾く) ----

  it("(逐次) 2 名なら 1 名目の生 UPDATE 無効化は通り、2 名目 (最後) は KT001 で拒否", async () => {
    const [a, b] = await freshAdmins(2);
    expect(await runRaw("deactivate", a)).toBe("ok"); // 2 → 1 は許可 (常時拒否のトリガではない)
    expect(await runRaw("deactivate", b)).toBe("blocked"); // 最後の 1 名は拒否
    expect(await activeAdminCount()).toBe(1);
  });

  it("(逐次) 最後の 1 名の生 DELETE は KT001 で拒否、admin が 1 名残る", async () => {
    const [a] = await freshAdmins(1);
    expect(await runRaw("delete", a)).toBe("blocked");
    expect(await activeAdminCount()).toBe(1);
  });

  it("(逐次) 最後の 1 名の生 降格 (school_admin→teacher) は KT001 で拒否", async () => {
    const [a] = await freshAdmins(1);
    expect(await runRaw("demote", a)).toBe("blocked");
    expect(await activeAdminCount()).toBe(1);
  });

  // ---- 正例 (除去遷移でないものは通す = 通常更新を penalize しない) ----

  it("(正例) teacher の無効化は admin を減らさないので許可 (admin 1 名のみの校でも)", async () => {
    await freshAdmins(1);
    const teacher = await addUser("teacher", "l2-teacher-1");
    expect(await runRaw("deactivate", teacher)).toBe("ok");
    expect(await activeAdminCount()).toBe(1);
  });

  it("(正例) 無効化済み admin の再有効化は除去遷移でないので許可", async () => {
    const [a] = await freshAdmins(2); // a の他にもう 1 名 active admin が居る
    expect(await runRaw("deactivate", a)).toBe("ok"); // a を無効化 (2→1)
    expect(await runRaw("reactivate", a)).toBe("ok"); // 再有効化 (false→true) は除去遷移でない
    expect(await activeAdminCount()).toBe(2);
  });

  it("(正例) teacher→school_admin 昇格は許可 (管理者を増やす)", async () => {
    await freshAdmins(1);
    const teacher = await addUser("teacher", "l2-promote");
    expect(await runRaw("promote", teacher)).toBe("ok");
    expect(await activeAdminCount()).toBe(2);
  });

  // ---- 跨接続 並行 (トリガ単独の直列化が核心) ----

  it("(跨接続) 最後の 2 名を 2 接続で同時に生無効化 → advisory lock 直列化で 1 名だけ成功、1 名残る", async () => {
    const [a, b] = await freshAdmins(2);
    const results = await Promise.all([runRaw("deactivate", a), runRaw("deactivate", b)]);
    expect(results.filter((r) => r === "ok").length).toBe(1);
    expect(results.filter((r) => r === "blocked").length).toBe(1);
    expect(await activeAdminCount()).toBe(1); // 学校が「管理者ゼロ」にならない
  });

  it("(跨接続) N=5 を全接続で同時に生無効化しても有効 admin は必ず 1 名残る", async () => {
    const ids = await freshAdmins(5);
    const results = await Promise.all(ids.map((id) => runRaw("deactivate", id)));
    expect(results.filter((r) => r === "ok").length).toBe(4);
    expect(results.filter((r) => r === "blocked").length).toBe(1);
    expect(await activeAdminCount()).toBe(1);
  });

  it("(跨接続) 無効化・降格・削除を混在させて同時実行しても 1 名残る (除去遷移の混在直列化)", async () => {
    const [a, b, c] = await freshAdmins(3);
    const results = await Promise.all([
      runRaw("deactivate", a),
      runRaw("demote", b),
      runRaw("delete", c),
    ]);
    expect(results.filter((r) => r === "ok").length).toBe(2); // 3→1 まで許可
    expect(results.filter((r) => r === "blocked").length).toBe(1); // 最後の 1 名分は拒否
    expect(await activeAdminCount()).toBe(1);
  });
});
