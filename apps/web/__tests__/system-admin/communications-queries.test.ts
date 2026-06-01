import type { TenantTx } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): listCommunicationsByAdvertiser / getCommunicationDetail の射影・絞り込み・並び・
 * ページングを検証。drizzle tx を構造的テストダブルに差し替え、`@kimiterrace/db` の communications は
 * カラム placeholder で mock。drizzle-orm の and/desc/eq は条件・並びをアサートできる tagged object に
 * 差し替える。
 */

vi.mock("@kimiterrace/db", () => ({
  communications: {
    id: { name: "id" },
    advertiserId: { name: "advertiser_id" },
    contractId: { name: "contract_id" },
    channel: { name: "channel" },
    occurredAt: { name: "occurred_at" },
    subject: { name: "subject" },
    bodyMd: { name: "body_md" },
    attachmentsJson: { name: "attachments_json" },
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
  getCommunicationDetail,
  listCommunicationsByAdvertiser,
} from "../../lib/system-admin/communications-queries";

const ADV_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

describe("listCommunicationsByAdvertiser", () => {
  it("射影は一覧用カラムのみ — 本文/添付は含めない", async () => {
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID);
    expect(Object.keys(projection ?? {}).sort()).toEqual(
      ["channel", "contractId", "createdAt", "id", "occurredAt", "subject"].sort(),
    );
    expect(projection).not.toHaveProperty("bodyMd");
    expect(projection).not.toHaveProperty("attachmentsJson");
  });

  it("advertiser_id で eq 絞り込み + 発生日時降順→記録時刻降順の並び", async () => {
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID);
    expect(whereArg).toEqual({ op: "eq", col: "advertiser_id", value: ADV_ID });
    expect(orderByArgs).toEqual([
      { dir: "desc", col: "occurred_at" },
      { dir: "desc", col: "created_at" },
    ]);
  });

  it("limit 既定 100 / offset 既定 0", async () => {
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID);
    expect(limitArg).toBe(100);
    expect(offsetArg).toBe(0);
  });

  it("limit は 1..500 にクランプ、offset は非負へ", async () => {
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID, { limit: 9999, offset: -5 });
    expect(limitArg).toBe(500);
    expect(offsetArg).toBe(0);
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID, { limit: 0 });
    expect(limitArg).toBe(1);
  });

  it("非有限 (NaN/Infinity) と小数は既定/floor に正規化 (.offset(NaN) を防ぐ)", async () => {
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID, {
      limit: Number.NaN,
      offset: Number.NaN,
    });
    expect(limitArg).toBe(100); // 既定
    expect(offsetArg).toBe(0); // 既定 (NaN ガード)
    await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID, {
      limit: Number.POSITIVE_INFINITY,
      offset: 12.9,
    });
    expect(limitArg).toBe(100); // Infinity は非有限 → 既定 (上限 500 へは丸めない)
    expect(offsetArg).toBe(12); // floor
  });

  it("tx の結果をそのまま返す (手書きテナント WHERE を足さない — 可視範囲は RLS)", async () => {
    rows = [
      {
        id: COMM_ID,
        contractId: null,
        channel: "email",
        occurredAt: new Date(0),
        subject: "問い合わせ",
        createdAt: new Date(0),
      },
    ];
    expect(await listCommunicationsByAdvertiser(fakeListTx(), ADV_ID)).toEqual(rows);
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

describe("getCommunicationDetail", () => {
  beforeEach(() => {
    detailProjection = null;
    detailWhere = undefined;
    detailLimit = undefined;
    detailRows = [];
  });

  it("射影は本文・添付・紐づく契約を含む全表示フィールド", async () => {
    await getCommunicationDetail(fakeDetailTx(), COMM_ID);
    expect(Object.keys(detailProjection ?? {}).sort()).toEqual(
      [
        "advertiserId",
        "attachmentsJson",
        "bodyMd",
        "channel",
        "contractId",
        "createdAt",
        "id",
        "occurredAt",
        "subject",
      ].sort(),
    );
  });

  it("advertiserId 省略時は id だけで eq + limit(1)", async () => {
    await getCommunicationDetail(fakeDetailTx(), COMM_ID);
    expect(detailWhere).toEqual({ op: "eq", col: "id", value: COMM_ID });
    expect(detailLimit).toBe(1);
  });

  it("advertiserId 指定時は id AND advertiser_id で防御的に絞る", async () => {
    await getCommunicationDetail(fakeDetailTx(), COMM_ID, ADV_ID);
    expect(detailWhere).toEqual({
      op: "and",
      parts: [
        { op: "eq", col: "id", value: COMM_ID },
        { op: "eq", col: "advertiser_id", value: ADV_ID },
      ],
    });
  });

  it("ヒットしたら 1 行、無ければ null", async () => {
    const row = {
      id: COMM_ID,
      advertiserId: ADV_ID,
      contractId: null,
      channel: "meeting",
      occurredAt: new Date(0),
      subject: "商談",
      bodyMd: "# 議事録",
      attachmentsJson: [],
      createdAt: new Date(0),
    };
    detailRows = [row];
    expect(await getCommunicationDetail(fakeDetailTx(), COMM_ID)).toEqual(row);
    detailRows = [];
    expect(await getCommunicationDetail(fakeDetailTx(), COMM_ID)).toBeNull();
  });
});
