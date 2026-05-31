import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MagicLinkClassNotFoundError,
  classBelongsToTenant,
  createClassMagicLink,
  listClassMagicLinks,
  resolveMagicLink,
  revokeMagicLink,
} from "../../src/queries/magic-links.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F05: クラス magic link / 生徒匿名アクセスの RLS・解決ロジックを検証する。
 *
 * 検証の核:
 *   - **匿名解決の扉**: `resolve_magic_link` (SECURITY DEFINER) は RLS context 無しの
 *     kimiterrace_app でも有効なクラスリンクを 1 行解決できる。一方、生 `magic_links` の
 *     直接 SELECT は context 無しでは 0 件 (deny by default) — 扉は 1 本だけ。
 *   - **扉が漏らさない**: 失効済 / 期限切れ / 非クラスリンク (旧保護者リンク) / 不明 token は
 *     すべて 0 行 → 呼び出し側が 410/404 にマップできる。
 *   - **教員管理側**: createClassMagicLink / revokeMagicLink / listClassMagicLinks は
 *     tenant_isolation 下で自校のみ。他校 school_id INSERT は WITH CHECK で拒否。
 */
describeOrSkip("F05: magic_links class link + anonymous resolve (#12)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classB: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);

    classA = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, academic_year, name, grade)
        VALUES (${fx.schoolA}, 2026, '1-A', 1) RETURNING id
      `
    )[0].id;
    classB = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, academic_year, name, grade)
        VALUES (${fx.schoolB}, 2026, '1-B', 1) RETURNING id
      `
    )[0].id;

    // owner 接続 (RESET ROLE = RLS バイパス) で解決テスト用の固定リンクを投入。
    // token_hash はアプリ層でハッシュ化済の値を模した任意文字列。
    await sql`INSERT INTO magic_links (school_id, class_id, token_hash, expires_at, revoked_at)
      VALUES (${fx.schoolA}, ${classA}, 'hash-valid-A', now() + interval '30 days', NULL)`;
    await sql`INSERT INTO magic_links (school_id, class_id, token_hash, expires_at, revoked_at)
      VALUES (${fx.schoolA}, ${classA}, 'hash-revoked', now() + interval '30 days', now())`;
    await sql`INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
      VALUES (${fx.schoolA}, ${classA}, 'hash-expired', now() - interval '1 day')`;
    await sql`INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
      VALUES (${fx.schoolB}, ${classB}, 'hash-valid-B', now() + interval '30 days')`;
    // 旧・保護者単回リンク (class_id NULL) — F05 の扉からは解決させない
    await sql`INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
      VALUES (${fx.schoolA}, NULL, 'hash-no-class', now() + interval '30 days')`;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- 匿名解決 (SECURITY DEFINER) ---

  it("resolve: context 無しの kimiterrace_app が有効なクラスリンクを解決 (SECURITY DEFINER)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      // app.current_school_id を一切設定しない (生徒は未確定)
      const r = await resolveMagicLink(db, "hash-valid-A");
      expect(r).not.toBeNull();
      expect(r?.schoolId).toBe(fx.schoolA);
      expect(r?.classId).toBe(classA);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("deny by default: context 無しで magic_links を直接 SELECT すると 0 件 (扉は resolve のみ)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const direct = await tx`SELECT id FROM magic_links WHERE token_hash = 'hash-valid-A'`;
      expect(direct).toHaveLength(0);
    });
  });

  it("resolve: 失効済リンクは null (→ 410 Gone)", async () => {
    const db = drizzle(sql);
    await sql.unsafe("SET ROLE kimiterrace_app");
    try {
      expect(await resolveMagicLink(db, "hash-revoked")).toBeNull();
    } finally {
      await sql.unsafe("RESET ROLE");
    }
  });

  it("resolve: 期限切れリンクは null", async () => {
    const db = drizzle(sql);
    await sql.unsafe("SET ROLE kimiterrace_app");
    try {
      expect(await resolveMagicLink(db, "hash-expired")).toBeNull();
    } finally {
      await sql.unsafe("RESET ROLE");
    }
  });

  it("resolve: expires_at = now() ちょうどは null、now()+1μs は解決 (strict > 境界、#147 L2)", async () => {
    // 同一トランザクション内では now() = transaction_timestamp() で固定される。
    // INSERT の expires_at = now() と resolve_magic_link 内の now() が**完全一致**するため、
    // `expires_at > now()` (strict) なら境界ちょうどは 0 件、`>=` に退行すると 1 件になる。
    // これにより「期限ちょうどのリンクは失効扱い」という strict 比較を決定論的に固定する。
    // (関数は SECURITY DEFINER だがトランザクションは呼出側と同一なので now() は共有)。
    // 結果は tx 内で収集し、assert は tx 外で行う (sentinel throw で rollback しつつ
    // assertion 失敗を握り潰さないため)。
    const ROLLBACK = Symbol("rollback");
    // -1 で初期化し、tx が assert 前に抜けた (= 収集前に例外等) 場合は 0/1 と一致せず必ず fail する。
    let atBoundaryLen = -1;
    let justFutureLen = -1;
    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
          VALUES (${fx.schoolA}, ${classA}, 'hash-boundary-eq', now())
        `;
        await tx`
          INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
          VALUES (${fx.schoolA}, ${classA}, 'hash-boundary-future', now() + interval '1 microsecond')
        `;
        atBoundaryLen = (await tx`SELECT id FROM resolve_magic_link('hash-boundary-eq')`).length;
        justFutureLen = (await tx`SELECT id FROM resolve_magic_link('hash-boundary-future')`)
          .length;
        // fixture を汚さないよう sentinel で rollback (INSERT は永続化しない)。
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    expect(atBoundaryLen).toBe(0); // expires_at = now() は失効扱い (strict >)
    expect(justFutureLen).toBe(1); // 1μs でも未来なら有効
  });

  it("resolve: 非クラスリンク (class_id NULL = 旧保護者リンク) は null", async () => {
    const db = drizzle(sql);
    await sql.unsafe("SET ROLE kimiterrace_app");
    try {
      expect(await resolveMagicLink(db, "hash-no-class")).toBeNull();
    } finally {
      await sql.unsafe("RESET ROLE");
    }
  });

  it("resolve: 不明な token は null", async () => {
    const db = drizzle(sql);
    await sql.unsafe("SET ROLE kimiterrace_app");
    try {
      expect(await resolveMagicLink(db, "hash-does-not-exist")).toBeNull();
    } finally {
      await sql.unsafe("RESET ROLE");
    }
  });

  it("resolve: 別テナントの token も自身の school_id/class_id で解決できる (テナント非依存の扉)", async () => {
    const db = drizzle(sql);
    await sql.unsafe("SET ROLE kimiterrace_app");
    try {
      const r = await resolveMagicLink(db, "hash-valid-B");
      expect(r?.schoolId).toBe(fx.schoolB);
      expect(r?.classId).toBe(classB);
    } finally {
      await sql.unsafe("RESET ROLE");
    }
  });

  // --- 教員管理側 (RLS context 下) ---

  it("createClassMagicLink: 自校 context で発行でき、デフォルト期限は約 90 日", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const issued = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_id', ${fx.userA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
        return createClassMagicLink(tx, {
          schoolId: fx.schoolA,
          classId: classA,
          tokenHash: "hash-created-A",
          actorUserId: fx.userA,
        });
      });
      expect(issued.classId).toBe(classA);
      expect(issued.revokedAt).toBeNull();
      const days = (issued.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThan(91);

      // 発行が audit_log に insert として残る (ルール1)。owner 接続で確認 (token は載らない)。
      const audit = await sql<{ operation: string; diff: Record<string, unknown> }[]>`
        SELECT operation, diff FROM audit_log
        WHERE table_name = 'magic_links' AND record_id = ${issued.id}
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0].operation).toBe("insert");
      expect(JSON.stringify(audit[0].diff)).not.toContain("hash-created-A");
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("createClassMagicLink: 他校の classId は MagicLinkClassNotFoundError で拒否 (ねじれ行防止)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
          await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
          await tx.execute(dsql`SELECT set_config('app.current_user_id', ${fx.userA}, true)`);
          await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
          // school A context で school B の classId → 自校に存在せず拒否
          await createClassMagicLink(tx, {
            schoolId: fx.schoolA,
            classId: classB,
            tokenHash: "hash-twisted",
            actorUserId: fx.userA,
          });
        }),
      ).rejects.toThrow(MagicLinkClassNotFoundError);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("classBelongsToTenant: 自校クラスは true、他校クラスは false (RLS)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const [own, other] = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
        return Promise.all([classBelongsToTenant(tx, classA), classBelongsToTenant(tx, classB)]);
      });
      expect(own).toBe(true);
      expect(other).toBe(false);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("createClassMagicLink: 他校 school_id を渡すと WITH CHECK で拒否される", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
          await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
          await tx.execute(dsql`SELECT set_config('app.current_user_id', ${fx.userA}, true)`);
          await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
          // 自校 classA でクラス検証は通すが、school_id だけ他校 → tenant_isolation の
          // WITH CHECK で INSERT 拒否 (class ガードではなく RLS が止めることを検証)。
          await createClassMagicLink(tx, {
            schoolId: fx.schoolB,
            classId: classA,
            tokenHash: "hash-cross-tenant",
            actorUserId: fx.userA,
          });
        }),
      ).rejects.toThrow();
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("revokeMagicLink: 失効後は resolve が null を返す (冪等)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      // 専用リンクを owner で投入
      await sql`INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
        VALUES (${fx.schoolA}, ${classA}, 'hash-to-revoke', now() + interval '30 days')`;
      const id = (
        await sql<{ id: string }[]>`SELECT id FROM magic_links WHERE token_hash = 'hash-to-revoke'`
      )[0].id;

      const first = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_id', ${fx.userA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
        return revokeMagicLink(tx, id, fx.userA);
      });
      expect(first?.revokedAt).not.toBeNull();

      // 失効が audit_log に update として残る (ルール1)。
      const audit = await sql<{ operation: string }[]>`
        SELECT operation FROM audit_log
        WHERE table_name = 'magic_links' AND record_id = ${id} AND operation = 'update'
      `;
      expect(audit).toHaveLength(1);

      // 2 回目は対象なし (既に失効) → undefined (冪等)
      const second = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_id', ${fx.userA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
        return revokeMagicLink(tx, id, fx.userA);
      });
      expect(second).toBeUndefined();

      // resolve も null
      await sql.unsafe("SET ROLE kimiterrace_app");
      try {
        expect(await resolveMagicLink(drizzle(sql), "hash-to-revoke")).toBeNull();
      } finally {
        await sql.unsafe("RESET ROLE");
      }
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("listClassMagicLinks: 自校 context では失効済を除いた自クラスのリンクのみ返す", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const rows = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
        return listClassMagicLinks(tx, classA);
      });
      // hash-valid-A (有効) は含む。hash-revoked は除外。
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.revokedAt === null)).toBe(true);
      expect(rows.every((r) => r.classId === classA)).toBe(true);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("listClassMagicLinks: 他校 context では別校クラスのリンクは見えない (RLS)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const rows = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'teacher', true)`);
        // school B context で school A のクラスを問い合わせ → RLS で 0 件
        return listClassMagicLinks(tx, classA);
      });
      expect(rows).toHaveLength(0);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });
});
