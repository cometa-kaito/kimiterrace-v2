import type { TenantTx } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F11 (#47 第2スライス): listSchoolMembers の射影・対象絞り込み・並び・passthrough を検証。
 * drizzle tx を構造的なテストダブルに差し替え、`@kimiterrace/db` の users はカラム placeholder で
 * mock。drizzle-orm の asc/desc/inArray は順序・対象をアサートできる tagged object を返す mock に
 * 差し替える (RLS 自体の検証は実 PG が要るため packages/db の RLS スイートに委ね、ここは query 形状)。
 */

vi.mock("@kimiterrace/db", () => ({
  users: {
    id: { name: "id" },
    displayName: { name: "display_name" },
    role: { name: "role" },
    isActive: { name: "is_active" },
    email: { name: "email" },
    schoolId: { name: "school_id" },
  },
}));
vi.mock("drizzle-orm", () => ({
  desc: (c: { name: string }) => ({ dir: "desc", col: c.name }),
  asc: (c: { name: string }) => ({ dir: "asc", col: c.name }),
  inArray: (c: { name: string }, values: unknown[]) => ({ op: "inArray", col: c.name, values }),
}));

import { listSchoolMembers } from "../../lib/role-management/members-queries";

let projection: Record<string, unknown> | null;
let fromArg: unknown;
let whereArg: unknown;
let orderByArgs: unknown[];
let rows: unknown[];

/** select(projection).from(table).where(cond).orderBy(...args) → rows を返す最小 tx ダブル。 */
function fakeTx(): TenantTx {
  const chain = {
    from: (t: unknown) => {
      fromArg = t;
      return chain;
    },
    where: (cond: unknown) => {
      whereArg = cond;
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      orderByArgs = args;
      return Promise.resolve(rows);
    },
  };
  const tx = {
    select: (p: Record<string, unknown>) => {
      projection = p;
      return chain;
    },
  };
  return tx as unknown as TenantTx;
}

beforeEach(() => {
  projection = null;
  fromArg = undefined;
  whereArg = undefined;
  orderByArgs = [];
  rows = [];
});

describe("listSchoolMembers", () => {
  it("射影は id / 表示名 / ロール / 状態のみ — email 等の PII は含めない (ルール4)", async () => {
    await listSchoolMembers(fakeTx());
    expect(Object.keys(projection ?? {}).sort()).toEqual(
      ["displayName", "id", "isActive", "role"].sort(),
    );
    expect(projection).not.toHaveProperty("email");
    expect(projection).not.toHaveProperty("schoolId");
  });

  it("対象絞り込みは教職員ロール (school_admin / teacher) のみ — student / guardian を除外", async () => {
    await listSchoolMembers(fakeTx());
    expect(whereArg).toEqual({
      op: "inArray",
      col: "role",
      values: ["school_admin", "teacher"],
    });
  });

  it("並びは is_active 降順 → role 昇順 → display_name 昇順 (稼働中を先頭に決定的)", async () => {
    await listSchoolMembers(fakeTx());
    expect(fromArg).toBeDefined();
    expect(orderByArgs).toEqual([
      { dir: "desc", col: "is_active" },
      { dir: "asc", col: "role" },
      { dir: "asc", col: "display_name" },
    ]);
  });

  it("tx の結果をそのまま返す (手書きのテナント WHERE を足さない — 自校境界は RLS)", async () => {
    rows = [
      { id: "u1", displayName: "管理者 A", role: "school_admin", isActive: true },
      { id: "u2", displayName: "教員 B", role: "teacher", isActive: false },
    ];
    const result = await listSchoolMembers(fakeTx());
    expect(result).toEqual(rows);
  });
});
