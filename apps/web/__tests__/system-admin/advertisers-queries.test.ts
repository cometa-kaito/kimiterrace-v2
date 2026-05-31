import type { TenantTx } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): listAdvertisers の射影・並び・passthrough を検証。drizzle tx を構造的なテストダブルに
 * 差し替え、`@kimiterrace/db` の advertisers はカラム placeholder で mock する (desc/asc は実物)。
 */

vi.mock("@kimiterrace/db", () => ({
  advertisers: {
    id: { name: "id" },
    companyName: { name: "company_name" },
    industry: { name: "industry" },
    contactEmail: { name: "contact_email" },
    isActive: { name: "is_active" },
    createdAt: { name: "created_at" },
  },
}));

import { listAdvertisers } from "../../lib/system-admin/advertisers-queries";

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

  it("advertisers を 2 キー (is_active / company_name) で並べる", async () => {
    await listAdvertisers(fakeTx());
    expect(fromArg).toBeDefined();
    expect(orderByArgs).toHaveLength(2);
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
