import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listAllStaff } from "../../src/queries/users.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F11 (#47 / #324): system_admin 全校横断 教職員ディレクトリ `listAllStaff` を実 PG (RLS 込み) で検証する。
 *
 * `listSchoolMembers` (自校版) に対する**全校版**。観点:
 * (1) **system_admin context は全校の教職員**を返す (`system_admin_full_access`、cross-tenant)、
 * (2) student / guardian を除外し教職員ロールのみ、
 * (3) 並び (学校名昇順 → role 昇順 → 表示名昇順)、
 * (4) **多層防御** — school_admin context で呼んでも RLS が自校のみに絞り**越境しない**、
 * (5) 空コンテキストは deny-by-default、
 * (6) 射影に email (PII) を含めない・所属校 (schoolId/schoolName) は含む (ルール4)。
 */
describeOrSkip("F11 listAllStaff (全校横断 教職員ディレクトリ、RLS + 射影)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let teacherA1: string;
  let teacherA2: string;
  let teacherB1: string;

  // system_admin context (users 行ではないため userId は system_admins.id、schoolId なし)。
  const ctxSys = () => ({ userId: fx.sysAdmin, role: "system_admin" as const });
  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });

  async function seedUser(
    schoolId: string,
    uid: string,
    role: "school_admin" | "teacher" | "student" | "guardian",
    displayName: string,
    isActive = true,
  ): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO users (school_id, identity_uid, role, display_name, email, is_active)
      VALUES (${schoolId}, ${uid}, ${role}, ${displayName}, ${`${uid}@example.com`}, ${isActive})
      RETURNING id
    `;
    return row.id;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    // fixture: schoolA="テスト高校 A" / schoolB="テスト高校 B"、userA/userB は各校 school_admin。
    // A 校に 教員×2 (うち1名無効) + 生徒×1 + 保護者×1、B 校に 教員×1 を足す。表示名は **共通プレフィックス +
    // ASCII 数字**で差をつけ、照合順 (collation) 非依存で並びが決定的になるようにする (教 vs 退 のような
    // ロケール依存比較を避ける、members-list テストと同方針)。
    teacherA1 = await seedUser(fx.schoolA, "uid-A-t1", "teacher", "教員A1");
    teacherA2 = await seedUser(fx.schoolA, "uid-A-t2", "teacher", "教員A2", false);
    await seedUser(fx.schoolA, "uid-A-s1", "student", "生徒X");
    await seedUser(fx.schoolA, "uid-A-g1", "guardian", "保護者Y");
    teacherB1 = await seedUser(fx.schoolB, "uid-B-t1", "teacher", "B校教員");
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("system_admin は全校の教職員を返す — 生徒/保護者は除外 (cross-tenant)", async () => {
    const rows = await withTenantContext(db, ctxSys(), (tx) => listAllStaff(tx), APP);
    const ids = rows.map((r) => r.id).sort();
    // A: 管理者A + 教員A1 + 教員A2(無効)、B: 管理者B + B校教員。生徒/保護者は含まない。
    expect(ids).toEqual([fx.userA, teacherA1, teacherA2, fx.userB, teacherB1].sort());
    expect(rows.every((r) => r.role === "school_admin" || r.role === "teacher")).toBe(true);
  });

  it("並びは 学校名昇順 → role 昇順 (school_admin→teacher) → 表示名昇順で決定的", async () => {
    const rows = await withTenantContext(db, ctxSys(), (tx) => listAllStaff(tx), APP);
    // 学校 A (管理者A, 教員A1, 教員A2) → 学校 B (管理者B, B校教員)。
    expect(rows.map((r) => r.id)).toEqual([fx.userA, teacherA1, teacherA2, fx.userB, teacherB1]);
    // 学校境界をまたいでロールが入れ替わらない (school 単位で固まる)。
    expect(rows[0]).toMatchObject({ id: fx.userA, schoolId: fx.schoolA, role: "school_admin" });
    expect(rows[3]).toMatchObject({ id: fx.userB, schoolId: fx.schoolB, role: "school_admin" });
  });

  it("所属校名 (schoolName) を併せて返す", async () => {
    const rows = await withTenantContext(db, ctxSys(), (tx) => listAllStaff(tx), APP);
    const a1 = rows.find((r) => r.id === teacherA1);
    const b1 = rows.find((r) => r.id === teacherB1);
    expect(a1?.schoolName).toBe("テスト高校 A");
    expect(b1?.schoolName).toBe("テスト高校 B");
  });

  it("多層防御: school_admin context で呼んでも RLS が自校のみに絞り越境しない", async () => {
    const rows = await withTenantContext(db, ctxA(), (tx) => listAllStaff(tx), APP);
    // 自校 A の教職員のみ。B 校 (管理者B / B校教員) は一切見えない。
    expect(rows.map((r) => r.id).sort()).toEqual([fx.userA, teacherA1, teacherA2].sort());
    expect(rows.map((r) => r.id)).not.toContain(teacherB1);
    expect(rows.map((r) => r.id)).not.toContain(fx.userB);
    expect(rows.every((r) => r.schoolId === fx.schoolA)).toBe(true);
  });

  it("空コンテキストは deny-by-default で空配列", async () => {
    const rows = await withTenantContext(db, {}, (tx) => listAllStaff(tx), APP);
    expect(rows).toEqual([]);
  });

  it("射影は id / 表示名 / ロール / 状態 / 所属校のみ — email (PII) を含めない (ルール4)", async () => {
    const rows = await withTenantContext(db, ctxSys(), (tx) => listAllStaff(tx), APP);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ["displayName", "id", "isActive", "role", "schoolId", "schoolName"].sort(),
      );
      expect(r).not.toHaveProperty("email");
    }
  });
});
