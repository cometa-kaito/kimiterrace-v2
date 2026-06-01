import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listSchoolMembers } from "../../src/queries/users.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F11 (#47 / #320): 自校教職員一覧 `listSchoolMembers` を実 PG (RLS 込み) で検証する。
 *
 * PR #318 では衝突回避で apps/web に inline していた本クエリを #320 で packages/db に昇格し、
 * **テナント分離 (越境 deny) を実 API 経由で直接証明する** (PR #318 Reviewer Low-1)。観点:
 * (1) school_admin context は自校の教職員のみ、(2) **テナント分離** — 別校メンバーが一切漏れない、
 * (3) student / guardian を除外し教職員ロールのみ、(4) 並び (is_active 降順 → role 昇順 → 表示名昇順)、
 * (5) 空コンテキストは deny-by-default、(6) 射影に email (PII) を含めない (ルール4)。
 */
describeOrSkip("F11 listSchoolMembers (自校教職員一覧、RLS + 射影)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let teacherA1: string;
  let teacherA2: string;
  let teacherADisabled: string;
  let teacherB1: string;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });

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
    // fixture は A/B に school_admin (管理者 A / 管理者 B) を 1 名ずつ作る。教職員一覧の観点を出すため
    // A 校に 教員×2 (active) + 教員×1 (無効) + 生徒×1、B 校に 教員×1 を足す。表示名はロール内で
    // 並びが決定的になるよう、同一プレフィックス + ASCII 数字で差をつける (照合順依存を避ける)。
    teacherA1 = await seedUser(fx.schoolA, "uid-A-t1", "teacher", "教員1");
    teacherA2 = await seedUser(fx.schoolA, "uid-A-t2", "teacher", "教員2");
    teacherADisabled = await seedUser(fx.schoolA, "uid-A-t9", "teacher", "退職教員", false);
    await seedUser(fx.schoolA, "uid-A-s1", "student", "生徒X");
    teacherB1 = await seedUser(fx.schoolB, "uid-B-t1", "teacher", "B校教員");
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("自校の教職員のみ返す — 生徒は除外、別校メンバーは RLS で不可視 (テナント分離)", async () => {
    const rows = await withTenantContext(db, ctxA(), (tx) => listSchoolMembers(tx), APP);
    const ids = rows.map((r) => r.id).sort();
    // A 校の school_admin (管理者 A) + 教員 3 名 (active2 + 無効1)。生徒・B 校は含まない。
    expect(ids).toEqual([fx.userA, teacherA1, teacherA2, teacherADisabled].sort());
    // 念のため B 校教員 id が混ざっていないこと。
    expect(rows.map((r) => r.id)).not.toContain(teacherB1);
    // 生徒 (student) ロールは出ない。
    expect(rows.every((r) => r.role === "school_admin" || r.role === "teacher")).toBe(true);
  });

  it("並びは is_active 降順 → role 昇順 (school_admin→teacher) → 表示名昇順で決定的", async () => {
    const rows = await withTenantContext(db, ctxA(), (tx) => listSchoolMembers(tx), APP);
    // active: 管理者A(school_admin) → 教員1 → 教員2、最後に 無効の 退職教員。
    expect(rows.map((r) => r.id)).toEqual([fx.userA, teacherA1, teacherA2, teacherADisabled]);
    // 無効アカウントは末尾 (is_active 降順)。
    expect(rows[rows.length - 1]).toMatchObject({ id: teacherADisabled, isActive: false });
    // 先頭は active な school_admin (role 昇順)。
    expect(rows[0]).toMatchObject({ id: fx.userA, role: "school_admin", isActive: true });
  });

  it("別テナント (B) からは A の教職員が一切見えない (越境 deny)", async () => {
    const rows = await withTenantContext(db, ctxB(), (tx) => listSchoolMembers(tx), APP);
    expect(rows.map((r) => r.id)).toEqual([fx.userB, teacherB1]);
    expect(rows.map((r) => r.id)).not.toContain(teacherA1);
  });

  it("空コンテキストは deny-by-default で空配列", async () => {
    const rows = await withTenantContext(db, {}, (tx) => listSchoolMembers(tx), APP);
    expect(rows).toEqual([]);
  });

  it("射影は id / 表示名 / ロール / 状態のみ — email (PII) を含めない (ルール4)", async () => {
    const rows = await withTenantContext(db, ctxA(), (tx) => listSchoolMembers(tx), APP);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["displayName", "id", "isActive", "role"].sort());
      expect(r).not.toHaveProperty("email");
    }
  });
});
