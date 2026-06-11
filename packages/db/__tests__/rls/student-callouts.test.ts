import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  type StudentCalloutInput,
  getCalloutsForClass,
  replaceStudentCallouts,
} from "../../src/queries/student-callouts.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * パターン2「生徒呼び出し」 student_callouts の RLS テナント分離 + read（クラス×日別・時刻順）を実 PG で検証。
 * 実名表示の境界は ADR-034。読み取り isolation は class_visitors と同型。
 */
describeOrSkip("RLS: student_callouts（生徒呼び出し）", () => {
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

  async function seedCallout(
    schoolId: string,
    classId: string,
    calloutDate: string,
    studentName: string,
    scheduledTime: string | null,
  ): Promise<void> {
    await raw`
      INSERT INTO student_callouts (school_id, class_id, callout_date, student_name, scheduled_time)
      VALUES (${schoolId}, ${classId}, ${calloutDate}, ${studentName}, ${scheduledTime})`;
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
    await raw`DELETE FROM student_callouts`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("当該クラス・当日の呼び出しを時刻昇順（未設定は末尾）→氏名で返す（別日/別クラスは除外）", async () => {
    await seedCallout(fx.schoolA, classA, today, "佐藤太郎", "10:30");
    await seedCallout(fx.schoolA, classA, today, "鈴木花子", "09:00");
    await seedCallout(fx.schoolA, classA, today, "田中一郎", null); // 時刻未設定 → 末尾
    await seedCallout(fx.schoolA, classA, "2020-01-01", "山田次郎", "08:00"); // 別日 → 除外
    await seedCallout(fx.schoolA, classA2, today, "高橋三郎", "07:00"); // 別クラス → 除外

    const rows = await withTenantContext(
      db,
      ctxA(),
      (tx) => getCalloutsForClass(tx, classA, today),
      APP,
    );
    expect(rows.map((r) => r.studentName)).toEqual(["鈴木花子", "佐藤太郎", "田中一郎"]);
  });

  it("テナント分離: A から B 校の呼び出しは見えない / B からは見える（RLS）", async () => {
    await seedCallout(fx.schoolA, classA, today, "佐藤太郎", "10:00");
    await seedCallout(fx.schoolB, classB, today, "B生徒", "10:00");

    const fromA = await withTenantContext(
      db,
      ctxA(),
      (tx) => getCalloutsForClass(tx, classB, today),
      APP,
    );
    expect(fromA).toEqual([]);
    const fromB = await withTenantContext(
      db,
      ctxB(),
      (tx) => getCalloutsForClass(tx, classB, today),
      APP,
    );
    expect(fromB.map((r) => r.studentName)).toEqual(["B生徒"]);
  });

  it("空コンテキストは deny-by-default で 0 件", async () => {
    await seedCallout(fx.schoolA, classA, today, "佐藤太郎", "10:00");
    const rows = await withTenantContext(
      db,
      {},
      (tx) => getCalloutsForClass(tx, classA, today),
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
        await tx`
          INSERT INTO student_callouts (school_id, class_id, callout_date, student_name)
          VALUES (${fx.schoolB}, ${classB}, ${today}, '不正')`;
      }),
    ).rejects.toThrow();
  });

  // --- replaceStudentCallouts（編集 Action コア・全置換書き込み） ---

  function input(studentName: string, scheduledTime: string | null): StudentCalloutInput {
    return { studentName, scheduledTime, location: null, reason: null };
  }

  it("replaceStudentCallouts: クラス×日付の呼び出しを全置換する（旧行は消えて新リストが入る）", async () => {
    await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        replaceStudentCallouts(tx, {
          schoolId: fx.schoolA,
          classId: classA,
          date: today,
          items: [input("佐藤太郎", "10:00"), input("鈴木花子", "09:00")],
          actorUserId: fx.userA,
        }),
      APP,
    );
    let rows = await withTenantContext(
      db,
      ctxA(),
      (tx) => getCalloutsForClass(tx, classA, today),
      APP,
    );
    expect(rows.map((r) => r.studentName)).toEqual(["鈴木花子", "佐藤太郎"]);

    const count = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        replaceStudentCallouts(tx, {
          schoolId: fx.schoolA,
          classId: classA,
          date: today,
          items: [input("田中一郎", null)],
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(count).toBe(1);
    rows = await withTenantContext(db, ctxA(), (tx) => getCalloutsForClass(tx, classA, today), APP);
    expect(rows.map((r) => r.studentName)).toEqual(["田中一郎"]);
  });

  it("replaceStudentCallouts: 他校クラスは不可視で null を返し書き込まない（cross-tenant 防止）", async () => {
    const result = await withTenantContext(
      db,
      ctxA(),
      (tx) =>
        replaceStudentCallouts(tx, {
          schoolId: fx.schoolA,
          classId: classB,
          date: today,
          items: [input("不正", "10:00")],
          actorUserId: fx.userA,
        }),
      APP,
    );
    expect(result).toBeNull();
    const rows = await withTenantContext(
      db,
      ctxB(),
      (tx) => getCalloutsForClass(tx, classB, today),
      APP,
    );
    expect(rows).toEqual([]);
  });
});
