import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listStaffDisplayNames } from "../../src/queries/users.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F03 / #289: 職員氏名 roster クエリ ({@link listStaffDisplayNames}) を実 PG (RLS 込み) で検証する。
 *
 * Vertex 送信前 PII マスキング (ルール4) の供給源なので、(a) 教員/学校管理者のみ返す、(b) 生徒/保護者は
 * 返さない、(c) is_active=false は除外、(d) 同名は重複排除、(e) **テナント越境しない (RLS)** を固定する。
 */
describeOrSkip("F03 listStaffDisplayNames (職員氏名 roster, RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "teacher" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const });

  async function addUser(
    schoolId: string,
    uid: string,
    role: string,
    name: string,
    isActive = true,
  ): Promise<void> {
    await raw`
      INSERT INTO users (school_id, identity_uid, role, display_name, is_active)
      VALUES (${schoolId}, ${uid}, ${role}::user_role, ${name}, ${isActive})
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // base fixture の userA/userB (school_admin) は残し、追加分のみ毎回入れ直す。
    await raw`DELETE FROM users WHERE identity_uid LIKE 'uid-staff-%'`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("教員 / 学校管理者の氏名を返す (生徒・保護者は除外)", async () => {
    await addUser(fx.schoolA, "uid-staff-t1", "teacher", "田中先生");
    await addUser(fx.schoolA, "uid-staff-stu", "student", "生徒X");
    await addUser(fx.schoolA, "uid-staff-gua", "guardian", "保護者Y");

    const names = await withTenantContext(db, ctxA(), (tx) => listStaffDisplayNames(tx), APP);
    expect(names).toContain("田中先生");
    expect(names).toContain("管理者 A"); // base fixture の school_admin
    expect(names).not.toContain("生徒X");
    expect(names).not.toContain("保護者Y");
  });

  it("is_active=false の職員は除外する", async () => {
    await addUser(fx.schoolA, "uid-staff-ret", "teacher", "退職先生", false);
    const names = await withTenantContext(db, ctxA(), (tx) => listStaffDisplayNames(tx), APP);
    expect(names).not.toContain("退職先生");
  });

  it("同名の職員は 1 度だけ返す (重複排除)", async () => {
    await addUser(fx.schoolA, "uid-staff-d1", "teacher", "鈴木先生");
    await addUser(fx.schoolA, "uid-staff-d2", "teacher", "鈴木先生");
    const names = await withTenantContext(db, ctxA(), (tx) => listStaffDisplayNames(tx), APP);
    expect(names.filter((n) => n === "鈴木先生")).toHaveLength(1);
  });

  it("テナント分離: 別校 (B) からは A の職員氏名が見えない (RLS)", async () => {
    await addUser(fx.schoolA, "uid-staff-a", "teacher", "A校の先生");
    const namesB = await withTenantContext(db, ctxB(), (tx) => listStaffDisplayNames(tx), APP);
    expect(namesB).not.toContain("A校の先生");
    expect(namesB).not.toContain("管理者 A");
    expect(namesB).toContain("管理者 B"); // B 自校分は見える
  });

  it("空コンテキストは deny-by-default で 0 件", async () => {
    const names = await withTenantContext(db, {}, (tx) => listStaffDisplayNames(tx), APP);
    expect(names).toHaveLength(0);
  });
});
