import type { TenantTx } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): listContractsByAdvertiser / getContractDetail の射影・絞り込み・並び・ページングを検証。
 * drizzle tx を構造的テストダブルに差し替え、`@kimiterrace/db` の contracts はカラム placeholder で
 * mock。drizzle-orm の and/desc/eq は条件・並びをアサートできる tagged object に差し替える
 * (communications-queries.test.ts と同方式)。
 */

vi.mock("@kimiterrace/db", () => ({
  contracts: {
    id: { name: "id" },
    advertiserId: { name: "advertiser_id" },
    status: { name: "status" },
    startedAt: { name: "started_at" },
    endedAt: { name: "ended_at" },
    monthlyFeeJpy: { name: "monthly_fee_jpy" },
    targetSchools: { name: "target_schools" },
    notes: { name: "notes" },
    createdAt: { name: "created_at" },
  },
}));
vi.mock("drizzle-orm", () => ({
  desc: (c: { name: string }) => ({ dir: "desc", col: c.name }),
  asc: (c: { name: string }) => ({ dir: "asc", col: c.name }),
  eq: (c: { name: string }, v: unknown) => ({ op: "eq", col: c.name, value: v }),
  and: (...parts: unknown[]) => ({ op: "and", parts }),
}));

import {
  getContractDetail,
  listContractsByAdvertiser,
} from "../../lib/system-admin/contracts-queries";

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTRACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let projection: Record<string, unknown> | null;
let whereArg: unknown;
let orderByArgs: unknown[];
let limitArg: number | undefined;
let offsetArg: number | undefined;
let rows: unknown[];

/** select(p).from(t).where(c).orderBy(...).limit(n).offset(m) → rows を返す list 用ダブル。 */
function fakeListTx(): TenantTx {
  const chain = {
    from: () => chain,
    where: (c: unknown) => {
      whereArg = c;
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      orderByArgs = args;
      return chain;
    },
    limit: (n: number) => {
      limitArg = n;
      return chain;
    },
    offset: (m: number) => {
      offsetArg = m;
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
  whereArg = undefined;
  orderByArgs = [];
  limitArg = undefined;
  offsetArg = undefined;
  rows = [];
});

describe("listContractsByAdvertiser", () => {
  it("射影は一覧用カラムのみ — 対象校/備考は含めない", async () => {
    await listContractsByAdvertiser(fakeListTx(), ADV_ID);
    expect(Object.keys(projection ?? {}).sort()).toEqual(
      ["createdAt", "endedAt", "id", "monthlyFeeJpy", "startedAt", "status"].sort(),
    );
    expect(projection).not.toHaveProperty("targetSchools");
    expect(projection).not.toHaveProperty("notes");
  });

  it("advertiser_id で eq 絞り込み + 開始日降順→記録時刻降順の並び", async () => {
    await listContractsByAdvertiser(fakeListTx(), ADV_ID);
    expect(whereArg).toEqual({ op: "eq", col: "advertiser_id", value: ADV_ID });
    expect(orderByArgs).toEqual([
      { dir: "desc", col: "started_at" },
      { dir: "desc", col: "created_at" },
    ]);
  });

  it("limit 既定 100 / offset 既定 0", async () => {
    await listContractsByAdvertiser(fakeListTx(), ADV_ID);
    expect(limitArg).toBe(100);
    expect(offsetArg).toBe(0);
  });

  it("limit は 1..500 にクランプ、offset は非負へ", async () => {
    await listContractsByAdvertiser(fakeListTx(), ADV_ID, { limit: 9999, offset: -5 });
    expect(limitArg).toBe(500);
    expect(offsetArg).toBe(0);
    await listContractsByAdvertiser(fakeListTx(), ADV_ID, { limit: 0 });
    expect(limitArg).toBe(1);
  });

  it("非有限 (NaN/Infinity) と小数は既定/floor に正規化 (.offset(NaN) を防ぐ)", async () => {
    await listContractsByAdvertiser(fakeListTx(), ADV_ID, {
      limit: Number.NaN,
      offset: Number.NaN,
    });
    expect(limitArg).toBe(100);
    expect(offsetArg).toBe(0);
    await listContractsByAdvertiser(fakeListTx(), ADV_ID, {
      limit: Number.POSITIVE_INFINITY,
      offset: 12.9,
    });
    expect(limitArg).toBe(100);
    expect(offsetArg).toBe(12);
  });

  it("tx の結果をそのまま返す (手書きテナント WHERE を足さない — 可視範囲は RLS)", async () => {
    rows = [
      {
        id: CONTRACT_ID,
        status: "active",
        startedAt: new Date(0),
        endedAt: null,
        monthlyFeeJpy: 50000,
        createdAt: new Date(0),
      },
    ];
    expect(await listContractsByAdvertiser(fakeListTx(), ADV_ID)).toEqual(rows);
  });
});

let detailProjection: Record<string, unknown> | null;
let detailWhere: unknown;
let detailLimit: number | undefined;
let detailRows: unknown[];

/** select(p).from(t).where(c).limit(n) → detailRows を返す detail 用ダブル。 */
function fakeDetailTx(): TenantTx {
  const chain = {
    from: () => chain,
    where: (c: unknown) => {
      detailWhere = c;
      return chain;
    },
    limit: (n: number) => {
      detailLimit = n;
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

describe("getContractDetail", () => {
  beforeEach(() => {
    detailProjection = null;
    detailWhere = undefined;
    detailLimit = undefined;
    detailRows = [];
  });

  it("射影は対象校・備考・親広告主を含む全表示フィールド", async () => {
    await getContractDetail(fakeDetailTx(), CONTRACT_ID);
    expect(Object.keys(detailProjection ?? {}).sort()).toEqual(
      [
        "advertiserId",
        "endedAt",
        "id",
        "monthlyFeeJpy",
        "notes",
        "startedAt",
        "status",
        "targetSchools",
      ].sort(),
    );
  });

  it("advertiserId 省略時は id だけで eq + limit(1)", async () => {
    await getContractDetail(fakeDetailTx(), CONTRACT_ID);
    expect(detailWhere).toEqual({ op: "eq", col: "id", value: CONTRACT_ID });
    expect(detailLimit).toBe(1);
  });

  it("advertiserId 指定時は id AND advertiser_id で防御的に絞る", async () => {
    await getContractDetail(fakeDetailTx(), CONTRACT_ID, ADV_ID);
    expect(detailWhere).toEqual({
      op: "and",
      parts: [
        { op: "eq", col: "id", value: CONTRACT_ID },
        { op: "eq", col: "advertiser_id", value: ADV_ID },
      ],
    });
  });

  it("ヒットしたら 1 行、無ければ null", async () => {
    const row = {
      id: CONTRACT_ID,
      advertiserId: ADV_ID,
      status: "active",
      startedAt: new Date(0),
      endedAt: null,
      monthlyFeeJpy: 50000,
      targetSchools: [],
      notes: null,
    };
    detailRows = [row];
    expect(await getContractDetail(fakeDetailTx(), CONTRACT_ID)).toEqual(row);
    detailRows = [];
    expect(await getContractDetail(fakeDetailTx(), CONTRACT_ID)).toBeNull();
  });
});
