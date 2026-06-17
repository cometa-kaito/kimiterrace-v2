import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantScopedContext, withTenantContext } from "../../src/client.js";
import { auditLog, classes } from "../../src/schema/index.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * system_admin が特定校のクラス階層を編集する経路 (/ops/schools/[id]/hierarchy) の RLS + 監査を
 * 実 PG で固定する。
 *
 * apps/web の hub-actions は対象校を `withSession(..., { tenantScoped: true, schoolId })` で渡し、
 * system_admin を school_admin に降格して対象校に閉じる (tenantScopedContext, ADR-019 §#95)。降格後の
 * 監査 INSERT は `audit_log_insert` policy (0005) を満たす必要があり、system_admin は users 行を持たない
 * ため `created_by`/`updated_by` は **null** (FK 回避)、`actor_user_id` には acting uid を入れる
 * (toHubActor / HubActor の二系統)。本テストはその不変条件を DB レベルで実証する。
 *
 * tenant-scoped-context.test.ts が「降格で他校が不可視」を departments で示すのに対し、本ファイルは
 * 「降格 system_admin の **書き込み + 監査** が対象校で成立し、他校・FK・null actor では弾かれる」を固定する。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("system_admin 対象校スコープ: 階層 mutation + 監査 (実 PG)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
  const sql = createSql(url!);
  const db = drizzle(sql);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // 接続はテスト superuser のため appRole で kimiterrace_app に降格して RLS を効かせる。
  const APP = { appRole: "kimiterrace_app" } as const;
  // hub-actions の finish が張る ctx と同じ: system_admin を対象校で school_admin へ降格する。
  const scoped = (schoolId: string) =>
    tenantScopedContext({ userId: fx.sysAdmin, role: "system_admin" as const, schoolId });

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  }, 20000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("降格 system_admin は対象校 A にクラスを作成でき、actor_user_id=uid / created_by=null の監査が通る", async () => {
    const classId = await withTenantContext(
      db,
      scoped(fx.schoolA),
      async (tx) => {
        const [row] = await tx
          .insert(classes)
          .values({
            schoolId: fx.schoolA,
            name: "システム作成クラス",
            grade: 1,
            // system_admin は users 行が無い → created_by/updated_by は null (FK 回避、ルール1)
            createdBy: null,
            updatedBy: null,
          })
          .returning({ id: classes.id });
        await tx.insert(auditLog).values({
          // 降格後 (role=school_admin) の 0005 policy: actor_user_id = app.current_user_id を満たす acting uid
          actorUserId: fx.sysAdmin,
          actorIdentityUid: fx.sysAdmin,
          schoolId: fx.schoolA,
          tableName: "classes",
          recordId: row.id,
          operation: "insert",
          diff: { after: { name: "システム作成クラス" } },
          rowHash: "",
          createdBy: null,
          updatedBy: null,
        });
        return row.id;
      },
      APP,
    );

    // 所有者接続 (RLS 外) で実在と監査を確認する。
    const rows = await sql<{ school_id: string }[]>`
      select school_id from classes where id = ${classId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].school_id).toBe(fx.schoolA);

    const audit = await sql<{ actor_user_id: string; created_by: string | null }[]>`
      select actor_user_id, created_by from audit_log where record_id = ${classId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(fx.sysAdmin);
    expect(audit[0].created_by).toBeNull();
  });

  it("降格 system_admin (対象校 A) は他校 B にクラスを作成できない (tenant_isolation WITH CHECK)", async () => {
    await expect(
      withTenantContext(
        db,
        scoped(fx.schoolA),
        (tx) =>
          tx.insert(classes).values({
            schoolId: fx.schoolB, // 他校 → WITH CHECK 違反
            name: "越境クラス",
            grade: 1,
            createdBy: null,
            updatedBy: null,
          }),
        APP,
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("監査 created_by に非 users uid を入れると FK 違反 (= null にする理由を固定)", async () => {
    await expect(
      withTenantContext(
        db,
        scoped(fx.schoolA),
        (tx) =>
          tx.insert(auditLog).values({
            actorUserId: fx.sysAdmin,
            schoolId: fx.schoolA,
            tableName: "classes",
            recordId: fx.schoolA, // 形式上の uuid (record 実在は問わない)
            operation: "insert",
            diff: {},
            rowHash: "",
            createdBy: fx.sysAdmin, // users 行が無い uid → FK 違反
            updatedBy: fx.sysAdmin,
          }),
        APP,
      ),
    ).rejects.toThrow(/foreign key|violates foreign key/i);
  });

  it("降格経路 (role=school_admin) で actor_user_id=null の監査は 0005 policy が拒否する", async () => {
    // 降格後 system_admin は role=school_admin として振る舞う。その role で actor_user_id=null は
    // 0005 が拒否する (だから actor_user_id に acting uid を入れる必要がある)。
    await expect(
      withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "school_admin", schoolId: fx.schoolA },
        (tx) =>
          tx.insert(auditLog).values({
            actorUserId: null,
            schoolId: fx.schoolA,
            tableName: "classes",
            recordId: fx.schoolA,
            operation: "insert",
            diff: {},
            rowHash: "",
            createdBy: null,
            updatedBy: null,
          }),
        APP,
      ),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });
});
