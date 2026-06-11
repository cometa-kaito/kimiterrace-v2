import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  type ClassVisitorInput,
  getVisitorsForClass,
  replaceClassVisitors,
} from "../../src/queries/class-visitors.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * パターン2「来校者一覧」 class_visitors の RLS テナント分離 + read（クラス×日別・時刻順）を実 PG で検証する。
 *
 * - tenant_isolation: 自校のみ可視、別テナントへの INSERT は WITH CHECK で拒否、context 未設定で 0 件
 * - getVisitorsForClass: 当該クラス・当日のみ・時刻昇順（未設定は末尾）→ 氏名
 * 実 PG（DATABASE_URL）でのみ走り未設定ならスキップ（ADR-012）。read は appRole で降格し RLS を実際に効かせる。
 */
describeOrSkip("RLS: class_visitors（来校者一覧）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classA2: string;
  let classB: string;
  let today: string;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });

  async function seedClass(schoolId: string, name: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO classes (school_id, academic_year, name, grade)
      VALUES (${schoolId}, 2026, ${name}, 1) RETURNING id`;
    return row.id;
  }

  async function seedVisitor(
    schoolId: string,
    classId: string,
    visitDate: string,
    visitorName: string,
    scheduledTime: string | null,
  ): Promise<void> {
    await raw`
      INSERT INTO class_visitors (school_id, class_id, visit_date, visitor_name, scheduled_time)
      VALUES (${schoolId}, ${classId}, ${visitDate}, ${visitorName}, ${scheduledTime})`;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    classA = await seedClass(fx.schoolA, "1-A");
    classA2 = await seedClass(fx.schoolA, "2-C");
    classB = await seedClass(fx.schoolB, "1-B");
    const [row] = await raw<{ today: string }[]>`
      SELECT to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD') AS today`;
    today = row.today;
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM class_visitors`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("当該クラス・当日の来校者を時刻昇順（未設定は末尾）→氏名で返す（別日/別クラスは除外）", async () => {
    await seedVisitor(fx.schoolA, classA, today, "佐藤", "10:30");
    await seedVisitor(fx.schoolA, classA, today, "鈴木", "09:00");
    await seedVisitor(fx.schoolA, classA, today, "田中", null); // 時刻未設定 → 末尾
    await seedVisitor(fx.schoolA, classA, "2020-01-01", "山田", "08:00"); // 別日 → 除外
    await seedVisitor(fx.schoolA, classA2, today, "高橋", "07:00"); // 同校別クラス → 除外

    const rows = await withTenantContext(
      db,
      ctxA(),
      (tx) => getVisitorsForClass(tx, classA, today),
      APP,
    );
    expect(rows.map((r) => r.visitorName)).toEqual(["鈴木", "佐藤", "田中"]);
  });

  it("テナント分離: A コンテキストから B 校の来校者は見えない / B からは見える（RLS）", async () => {
    await seedVisitor(fx.schoolA, classA, today, "佐藤", "10:00");
    await seedVisitor(fx.schoolB, classB, today, "BVisitor", "10:00");

    const fromA = await withTenantContext(
      db,
      ctxA(),
      (tx) => getVisitorsForClass(tx, classB, today),
      APP,
    );
    expect(fromA).toEqual([]); // 別校クラスは RLS で 0
    const fromB = await withTenantContext(
      db,
      ctxB(),
      (tx) => getVisitorsForClass(tx, classB, today),
      APP,
    );
    expect(fromB.map((r) => r.visitorName)).toEqual(["BVisitor"]);
  });

  it("空コンテキストは deny-by-default で 0 件", async () => {
    await seedVisitor(fx.schoolA, classA, today, "佐藤", "10:00");
    const rows = await withTenantContext(
      db,
      {},
      (tx) => getVisitorsForClass(tx, classA, today),
      APP,
    );
    expect(rows).toEqual([]);
  });

  it("別テナントへの INSERT は WITH CHECK で拒否（cross-tenant 書込防止）", async () => {
    await expect(
      raw.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        // A コンテキストで B 校の行を入れようとする → tenant_isolation WITH CHECK 違反。
        await tx`
          INSERT INTO class_visitors (school_id, class_id, visit_date, visitor_name)
          VALUES (${fx.schoolB}, ${classB}, ${today}, '不正')`;
      }),
    ).rejects.toThrow();
  });

  // --- replaceClassVisitors（編集 Action コア・全置換書き込み） ---

  function input(visitorName: string, scheduledTime: string | null): ClassVisitorInput {
    return { visitorName, scheduledTime, affiliation: null, purpose: null, host: null, note: null };
  }

  it("replaceClassVisitors: クラス×日付の来校者を全置換する（旧行は消えて新リストが入る）", async () => {
    await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        replaceClassVisitors(tx, {
          schoolId: fx.schoolA,
          classId: classA,
          date: today,
          items: [input("佐藤", "10:00"), input("鈴木", "09:00")],
          actorUserId: fx.userA,
        }),
      APP,
    );
    let rows = await withTenantContext(
      db,
      ctxA(),
      (tx) => getVisitorsForClass(tx, classA, today),
      APP,
    );
    expect(rows.map((r) => r.visitorName)).toEqual(["鈴木", "佐藤"]); // 09:00, 10:00

    // 再保存（全置換）: 旧 2 件が消えて新 1 件のみ。
    const count = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        replaceClassVisitors(tx, {
          schoolId: fx.schoolA,
          classId: classA,
          date: today,
          items: [input("田中", null)],
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(count).toBe(1);
    rows = await withTenantContext(db, ctxA(), (tx) => getVisitorsForClass(tx, classA, today), APP);
    expect(rows.map((r) => r.visitorName)).toEqual(["田中"]);
  });

  it("replaceClassVisitors: 他校クラスは不可視で null を返し書き込まない（cross-tenant 防止）", async () => {
    const result = await withTenantContext(
      db,
      ctxA(), // A コンテキストで B 校のクラスを対象に
      (tx) =>
        replaceClassVisitors(tx, {
          schoolId: fx.schoolA,
          classId: classB,
          date: today,
          items: [input("不正", "10:00")],
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(result).toBeNull();
    // B 校から見ても classB に来校者は入っていない（書き込まれていない）。
    const rows = await withTenantContext(
      db,
      ctxB(),
      (tx) => getVisitorsForClass(tx, classB, today),
      APP,
    );
    expect(rows).toEqual([]);
  });
});
