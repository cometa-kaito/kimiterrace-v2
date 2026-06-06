import type { TenantTx } from "@kimiterrace/db";
import { describe, expect, it } from "vitest";
import {
  EditorTargetNotFoundError,
  isUniqueViolation,
  upsertDailySectionForTarget,
} from "../../lib/editor/daily-data-write";
import type { EditorActor, EditorTarget } from "../../lib/editor/schedule-core";

/**
 * fake tx (drizzle TenantTx の最小サブセット) を関数のパラメータ型に合わせる helper。テスト専用の
 * 配線で、drizzle の生成的メソッド型を完全再現せず必要な呼び出し形だけを持つ fake を渡す
 * (ads-actions.test.ts 等の `as typeof withSession` 同系統の test キャストを 1 か所に局所化)。
 */
function asTx(fake: unknown): TenantTx {
  return fake as unknown as TenantTx;
}

/**
 * scope 汎用 daily_data upsert (段A-2) のカラムマッピング検証。
 *
 * `upsertDailySectionForTarget` が target の scope に応じて正しい `scope` + `*_id` 列を INSERT する
 * (`ck_daily_data_scope` 充足) ことを、INSERT の values を捕捉する fake tx で証明する。実 PG 非依存
 * (RLS の実効は #48-O 系の実 PG E2E に委譲、ここは配線とカラム導出の単体)。
 */

const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const DEPT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const GRADE_ID = "99999999-9999-4999-8999-999999999999";
const CLASS_ID = "11111111-1111-4111-8111-111111111111";
const DATE = "2026-06-01";

const actor: EditorActor = { userId: USER_ID, schoolId: SCHOOL_ID };

type Capture = {
  selectCount: number;
  insertedValues: Record<string, unknown> | null;
  updateSet: Record<string, unknown> | null;
  auditValues: Record<string, unknown> | null;
};

/**
 * fake tx。`existing` で「既存 daily_data 行が無い/ある」を切り替える。
 * - assertTargetVisible の可視確認 SELECT は `{ id }` のみを射影する → 常に 1 件を返す。
 * - 既存行 SELECT は `{ id, <field> }` を射影する → existing を返す (school は可視確認が無いので
 *   この SELECT が 1 回目になる。射影の形で判別するため selectCount の順序に依存しない)。
 * - insert は daily_data (returning) と audit_log (returning 無し) の 2 種を扱う。
 */
function fakeTx(existing: { id: string; [k: string]: unknown } | null, cap: Capture) {
  return {
    select: (projection: Record<string, unknown>) => {
      // 射影が id だけ = 可視確認、id + 他列 = 既存行確認。
      const isVisibilityCheck = Object.keys(projection).length === 1;
      const where = (_w: unknown) => ({
        limit: () => {
          cap.selectCount += 1;
          if (isVisibilityCheck) {
            return Promise.resolve([{ id: "visible" }]);
          }
          return Promise.resolve(existing ? [existing] : []);
        },
      });
      return { from: () => ({ where }) };
    },
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        // daily_data INSERT は scope/date を持つ、audit_log は tableName を持つ。
        if ("tableName" in vals) {
          cap.auditValues = vals;
          return Promise.resolve(undefined);
        }
        cap.insertedValues = vals;
        return { returning: () => Promise.resolve([{ id: "new-daily-1" }]) };
      },
    }),
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        cap.updateSet = vals;
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
}

function emptyCapture(): Capture {
  return { selectCount: 0, insertedValues: null, updateSet: null, auditValues: null };
}

const cases: Array<{
  name: string;
  target: EditorTarget;
  expect: {
    scope: string;
    gradeId: string | null;
    departmentId: string | null;
    classId: string | null;
  };
}> = [
  {
    name: "school",
    target: { scope: "school" },
    expect: { scope: "school", gradeId: null, departmentId: null, classId: null },
  },
  {
    name: "department",
    target: { scope: "department", departmentId: DEPT_ID },
    expect: { scope: "department", gradeId: null, departmentId: DEPT_ID, classId: null },
  },
  {
    name: "grade",
    target: { scope: "grade", gradeId: GRADE_ID },
    expect: { scope: "grade", gradeId: GRADE_ID, departmentId: null, classId: null },
  },
  {
    name: "class",
    target: { scope: "class", classId: CLASS_ID },
    expect: { scope: "class", gradeId: null, departmentId: null, classId: CLASS_ID },
  },
];

describe("upsertDailySectionForTarget: INSERT カラムマッピング (scope ごと)", () => {
  for (const c of cases) {
    it(`${c.name} scope は正しい scope + *_id 列を INSERT する`, async () => {
      const cap = emptyCapture();
      const id = await upsertDailySectionForTarget(
        asTx(fakeTx(null, cap)),
        actor,
        c.target,
        DATE,
        "schedules",
        [{ period: 1, subject: "数学" }],
      );
      expect(id).toBe("new-daily-1");
      expect(cap.insertedValues).toMatchObject({
        schoolId: SCHOOL_ID,
        scope: c.expect.scope,
        gradeId: c.expect.gradeId,
        departmentId: c.expect.departmentId,
        classId: c.expect.classId,
        date: DATE,
        schedules: [{ period: 1, subject: "数学" }],
        createdBy: USER_ID,
        updatedBy: USER_ID,
      });
      // 監査ログを daily_data 対象で同 tx 追記 (ルール1)。
      expect(cap.auditValues).toMatchObject({
        tableName: "daily_data",
        operation: "insert",
        recordId: "new-daily-1",
      });
    });
  }
});

describe("upsertDailySectionForTarget: UPDATE 経路", () => {
  it("既存行があれば対象カラムのみ UPDATE し updatedAt を明示する", async () => {
    const cap = emptyCapture();
    const id = await upsertDailySectionForTarget(
      asTx(fakeTx({ id: "daily-existing", notices: [] }, cap)),
      actor,
      { scope: "grade", gradeId: GRADE_ID },
      DATE,
      "notices",
      [{ text: "連絡" }],
    );
    expect(id).toBe("daily-existing");
    expect(cap.insertedValues).toBeNull(); // INSERT は走らない
    expect(cap.updateSet).toMatchObject({
      notices: [{ text: "連絡" }],
      updatedBy: USER_ID,
    });
    // updated_at を明示 (auditColumns に $onUpdate 無し、ルール「UPDATE で updated_at 明示」)。
    expect(cap.updateSet?.updatedAt).toBeInstanceOf(Date);
    expect(cap.auditValues).toMatchObject({ operation: "update", recordId: "daily-existing" });
  });
});

describe("upsertDailySectionForTarget: cross-tenant 可視確認", () => {
  it("対象が不可視 (可視確認 SELECT が 0 件) なら EditorTargetNotFoundError を投げる", async () => {
    const cap = emptyCapture();
    // 可視確認 (1 回目 select) が 0 件を返す fake。
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
    };
    await expect(
      upsertDailySectionForTarget(
        asTx(tx),
        actor,
        { scope: "class", classId: CLASS_ID },
        DATE,
        "schedules",
        [],
      ),
    ).rejects.toBeInstanceOf(EditorTargetNotFoundError);
    expect(cap.insertedValues).toBeNull();
  });

  it("school scope は id を持たないため可視確認 SELECT を行わず直接 INSERT する", async () => {
    const cap = emptyCapture();
    // 1 回目の select = 既存行確認 (school は可視確認をスキップするので、select は既存行用の 1 回のみ)。
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
      insert: (_t: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if ("tableName" in vals) {
            return Promise.resolve(undefined);
          }
          cap.insertedValues = vals;
          return { returning: () => Promise.resolve([{ id: "s1" }]) };
        },
      }),
    };
    const id = await upsertDailySectionForTarget(
      asTx(tx),
      actor,
      { scope: "school" },
      DATE,
      "assignments",
      [],
    );
    expect(id).toBe("s1");
    expect(cap.insertedValues).toMatchObject({ scope: "school", classId: null });
  });
});

describe("isUniqueViolation", () => {
  it("SQLSTATE 23505 を検出する", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
