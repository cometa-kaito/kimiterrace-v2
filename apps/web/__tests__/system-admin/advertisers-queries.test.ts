import type { TenantTx } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): listAdvertisers の射影・並び・passthrough を検証。drizzle tx を構造的なテストダブルに
 * 差し替え、`@kimiterrace/db` の advertisers はカラム placeholder で mock。drizzle-orm の asc/desc は
 * 並び順 (方向 + 対象カラム) をアサートできるよう tagged object を返す mock に差し替える。
 */

vi.mock("@kimiterrace/db", () => ({
  advertisers: {
    id: { name: "id" },
    companyName: { name: "company_name" },
    industry: { name: "industry" },
    contactEmail: { name: "contact_email" },
    contactPhone: { name: "contact_phone" },
    address: { name: "address" },
    notes: { name: "notes" },
    isActive: { name: "is_active" },
    createdAt: { name: "created_at" },
  },
}));
vi.mock("drizzle-orm", () => ({
  desc: (c: { name: string }) => ({ dir: "desc", col: c.name }),
  asc: (c: { name: string }) => ({ dir: "asc", col: c.name }),
  eq: (c: { name: string }, v: unknown) => ({ op: "eq", col: c.name, value: v }),
}));

import { getAdvertiserDetail, listAdvertisers } from "../../lib/system-admin/advertisers-queries";

let projection: Record<string, unknown> | null;
let fromArg: unknown;
let orderByArgs: unknown[];
let rows: unknown[];

/** select(projection).from(table).orderBy(...args) → rows を返す最小 tx ダブル。 */
function fakeTx(): TenantTx {
  const chain = {
    from: (t: unknown) => {
      fromArg = t;
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
  // 本番は drizzle の TenantTx。本テストは listAdvertisers が使う select/from/orderBy のみを供給する。
  return tx as unknown as TenantTx;
}

beforeEach(() => {
  projection = null;
  fromArg = undefined;
  orderByArgs = [];
  rows = [];
});

describe("listAdvertisers", () => {
  it("射影は一覧用カラムのみ — 住所/電話/備考は含めない", async () => {
    await listAdvertisers(fakeTx());
    expect(Object.keys(projection ?? {}).sort()).toEqual(
      ["companyName", "contactEmail", "createdAt", "id", "industry", "isActive"].sort(),
    );
    expect(projection).not.toHaveProperty("address");
    expect(projection).not.toHaveProperty("notes");
    expect(projection).not.toHaveProperty("contactPhone");
  });

  it("並びは is_active 降順 → company_name 昇順 (稼働中を先頭、会社名昇順)", async () => {
    await listAdvertisers(fakeTx());
    expect(fromArg).toBeDefined();
    expect(orderByArgs).toEqual([
      { dir: "desc", col: "is_active" },
      { dir: "asc", col: "company_name" },
    ]);
  });

  it("tx の結果をそのまま返す (手書き WHERE を足さない — 可視範囲は RLS)", async () => {
    rows = [
      {
        id: "a1",
        companyName: "X社",
        industry: null,
        contactEmail: null,
        isActive: true,
        createdAt: new Date(0),
      },
    ];
    const res = await listAdvertisers(fakeTx());
    expect(res).toEqual(rows);
  });
});

let detailProjection: Record<string, unknown> | null;
let whereArg: unknown;
let limitArg: number | undefined;
let detailRows: unknown[];

/** select(p).from(t).where(cond).limit(n) → detailRows を返す最小 tx ダブル。 */
function fakeDetailTx(): TenantTx {
  const chain = {
    from: () => chain,
    where: (cond: unknown) => {
      whereArg = cond;
      return chain;
    },
    limit: (n: number) => {
      limitArg = n;
      return Promise.resolve(detailRows);
    },
  };
  const tx = {
    select: (p: Record<string, unknown>) => {
      detailProjection = p;
      return chain;
    },
  };
  return tx as unknown as TenantTx;
}

describe("getAdvertiserDetail", () => {
  beforeEach(() => {
    detailProjection = null;
    whereArg = undefined;
    limitArg = undefined;
    detailRows = [];
  });

  it("射影は編集可能フィールド全部 (住所/電話/備考を含む)、is_active は含めない", async () => {
    await getAdvertiserDetail(fakeDetailTx(), "a1");
    expect(Object.keys(detailProjection ?? {}).sort()).toEqual(
      ["address", "companyName", "contactEmail", "contactPhone", "id", "industry", "notes"].sort(),
    );
    expect(detailProjection).not.toHaveProperty("isActive");
  });

  it("id で eq フィルタ + limit(1) を掛ける", async () => {
    await getAdvertiserDetail(fakeDetailTx(), "a1");
    expect(whereArg).toEqual({ op: "eq", col: "id", value: "a1" });
    expect(limitArg).toBe(1);
  });

  it("ヒットしたら 1 行をそのまま返す", async () => {
    const row = {
      id: "a1",
      companyName: "X社",
      industry: "広告",
      contactEmail: "a@example.com",
      contactPhone: null,
      address: null,
      notes: null,
    };
    detailRows = [row];
    expect(await getAdvertiserDetail(fakeDetailTx(), "a1")).toEqual(row);
  });

  it("ヒット無し (RLS 不可視 / 不存在) は null", async () => {
    detailRows = [];
    expect(await getAdvertiserDetail(fakeDetailTx(), "a1")).toBeNull();
  });
});
