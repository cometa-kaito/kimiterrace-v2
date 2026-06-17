import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantScopedContext, withTenantContext } from "../../src/client.js";
import { auditLog, classes, departments } from "../../src/schema/index.js";
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

/**
 * drizzle (postgres-js) は失敗クエリを `DrizzleQueryError` ("Failed query: ...") で包み、PG の理由
 * (RLS WITH CHECK / FK 違反など) は `cause` 連鎖側にある。raw `sql` の `.message` を直接照合する
 * 既存テストと違い drizzle tx 経由ではトップ message に理由が出ないため、message + cause 連鎖を辿って照合する。
 */
async function expectRejection(run: () => Promise<unknown>, re: RegExp): Promise<void> {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err, "rejection を期待したが解決した").toBeDefined();
  let text = "";
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    if (cur instanceof Error) {
      text += ` ${cur.message}`;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      text += ` ${String(cur)}`;
      break;
    }
  }
  expect(text).toMatch(re);
}

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

  it("降格 system_admin (A) からは他校 B の department が不可視 = createGrade の親結線 (existsInSchool) が cross-tenant を弾く", async () => {
    // 他校 B に学科を作る (所有者接続)。createGrade/updateGrade は departmentId の親を existsInSchool で
    // 「自校で可視か」RLS 経由で確認してから結線する (#73)。A スコープで B の学科が不可視なら、
    // 他校 department への付替は CrossTenantError になり成立しない。降格前 (raw system_admin) は
    // full_access で可視になり得たが、降格でそれが封じられることをここで固定する。
    const [deptB] = await sql<{ id: string }[]>`
      INSERT INTO departments (school_id, name, display_order)
      VALUES (${fx.schoolB}, '他校学科(不可視確認)', 9) RETURNING id`;
    const visible = await withTenantContext(
      db,
      scoped(fx.schoolA),
      (tx) =>
        tx
          .select({ id: departments.id })
          .from(departments)
          .where(eq(departments.id, deptB.id))
          .limit(1),
      APP,
    );
    expect(visible).toHaveLength(0);
  });

  it("降格 system_admin (対象校 A) は他校 B にクラスを作成できない (tenant_isolation WITH CHECK)", async () => {
    await expectRejection(
      () =>
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
      /row-level security|new row violates/i,
    );
  });

  it("監査 created_by に非 users uid を入れると FK 違反 (= null にする理由を固定)", async () => {
    await expectRejection(
      () =>
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
      /foreign key|violates foreign key/i,
    );
  });

  it("降格経路 (role=school_admin) で actor_user_id=null の監査は 0005 policy が拒否する", async () => {
    // 降格後 system_admin は role=school_admin として振る舞う。その role で actor_user_id=null は
    // 0005 が拒否する (だから actor_user_id に acting uid を入れる必要がある)。
    await expectRejection(
      () =>
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
      /row-level security|new row violates/i,
    );
  });
});
