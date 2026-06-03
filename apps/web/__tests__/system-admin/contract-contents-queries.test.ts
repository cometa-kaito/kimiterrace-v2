import type { TenantTx } from "@kimiterrace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F10 (#46): listLinkedContents の (a) INNER JOIN 射影 / (b) 紐付け日時降順 / (c) limit・offset クランプを
 * 検証する関数挙動テスト（PR #542/#543 Reviewer Low-1）。
 *
 * RLS/UNIQUE/cascade は `packages/db/__tests__/rls/contract-contents.test.ts` が実 PG で実証済み。本テストは
 * クエリ層の配線——どのカラムを **どの表から** 射影するか、結合条件、並び、ページング正規化——を pin する。
 * drizzle tx を構造的テストダブルに差し替え、`@kimiterrace/db` の表はカラム placeholder で mock
 * （contracts-queries.test.ts / communications-queries.test.ts と同方式）。
 *
 * **非空虚化のキモ**: contents / contract_contents の placeholder に `table` マーカーを持たせ、`title` と
 * `schoolId` が **JOIN 先の contents 由来**（contract_contents ではない）であることを placeholder の同一性で
 * 断言する。これで「INNER JOIN で contents のタイトル/所属校が射影される」を配線レベルで証明する。
 */

vi.mock("@kimiterrace/db", () => ({
  contractContents: {
    id: { table: "contract_contents", name: "id" },
    contractId: { table: "contract_contents", name: "contract_id" },
    contentId: { table: "contract_contents", name: "content_id" },
    createdAt: { table: "contract_contents", name: "created_at" },
  },
  contents: {
    id: { table: "contents", name: "id" },
    title: { table: "contents", name: "title" },
    schoolId: { table: "contents", name: "school_id" },
  },
}));
vi.mock("drizzle-orm", () => ({
  desc: (c: unknown) => ({ dir: "desc", col: c }),
  eq: (left: unknown, right: unknown) => ({ op: "eq", left, right }),
}));

import { contents, contractContents } from "@kimiterrace/db";
import { listLinkedContents } from "../../lib/system-admin/contract-contents-queries";

const CONTRACT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let projection: Record<string, unknown> | null;
let fromArg: unknown;
let joinTable: unknown;
let joinCond: unknown;
let whereArg: unknown;
let orderByArgs: unknown[];
let limitArg: number | undefined;
let offsetArg: number | undefined;
let rows: unknown[];

/** select(p).from(t).innerJoin(jt, jc).where(c).orderBy(...).limit(n).offset(m) → rows を返すダブル。 */
function fakeTx(): TenantTx {
  const chain = {
    from: (t: unknown) => {
      fromArg = t;
      return chain;
    },
    innerJoin: (t: unknown, cond: unknown) => {
      joinTable = t;
      joinCond = cond;
      return chain;
    },
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
  fromArg = undefined;
  joinTable = undefined;
  joinCond = undefined;
  whereArg = undefined;
  orderByArgs = [];
  limitArg = undefined;
  offsetArg = undefined;
  rows = [];
});

describe("listLinkedContents — (a) INNER JOIN 射影", () => {
  it("射影キーは linkId/contentId/title/schoolId/linkedAt のみ", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID);
    expect(Object.keys(projection ?? {}).sort()).toEqual(
      ["contentId", "linkId", "linkedAt", "schoolId", "title"].sort(),
    );
  });

  it("title/schoolId は JOIN 先 contents 由来、linkId/linkedAt は contract_contents 由来（出所を pin）", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID);
    // contents 側（INNER JOIN で取得する表示用カラム）
    expect(projection?.title).toBe(contents.title);
    expect(projection?.schoolId).toBe(contents.schoolId);
    expect(projection?.contentId).toBe(contents.id);
    // contract_contents 側（link 自体の id と紐付け日時）
    expect(projection?.linkId).toBe(contractContents.id);
    expect(projection?.linkedAt).toBe(contractContents.createdAt);
  });

  it("from は contract_contents、INNER JOIN は contents を content_id = contents.id で結合", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID);
    expect(fromArg).toBe(contractContents);
    expect(joinTable).toBe(contents);
    expect(joinCond).toEqual({
      op: "eq",
      left: contractContents.contentId,
      right: contents.id,
    });
  });
});

describe("listLinkedContents — (b) 絞り込みと並び", () => {
  it("contract_id で eq 絞り込み（対象特定であってテナント境界ではない — 可視範囲は RLS）", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID);
    expect(whereArg).toEqual({
      op: "eq",
      left: contractContents.contractId,
      right: CONTRACT_ID,
    });
  });

  it("紐付け日時 (created_at) 降順で新しい順、並びキーは 1 本のみ", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID);
    expect(orderByArgs).toEqual([{ dir: "desc", col: contractContents.createdAt }]);
  });
});

describe("listLinkedContents — (c) ページング正規化", () => {
  it("limit 既定 200 / offset 既定 0", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID);
    expect(limitArg).toBe(200);
    expect(offsetArg).toBe(0);
  });

  it("limit は 1..1000 にクランプ、offset は非負へ", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID, { limit: 9999, offset: -5 });
    expect(limitArg).toBe(1000);
    expect(offsetArg).toBe(0);
    await listLinkedContents(fakeTx(), CONTRACT_ID, { limit: 0 });
    expect(limitArg).toBe(1);
    await listLinkedContents(fakeTx(), CONTRACT_ID, { limit: -100 });
    expect(limitArg).toBe(1);
  });

  it("非有限 (NaN/Infinity) は既定へ、小数は floor（.limit(NaN)/.offset(NaN) を防ぐ）", async () => {
    await listLinkedContents(fakeTx(), CONTRACT_ID, {
      limit: Number.NaN,
      offset: Number.NaN,
    });
    expect(limitArg).toBe(200);
    expect(offsetArg).toBe(0);
    await listLinkedContents(fakeTx(), CONTRACT_ID, {
      limit: Number.POSITIVE_INFINITY,
      offset: 12.9,
    });
    expect(limitArg).toBe(200);
    expect(offsetArg).toBe(12);
    await listLinkedContents(fakeTx(), CONTRACT_ID, { limit: 50.9 });
    expect(limitArg).toBe(50);
  });

  it("tx の結果をそのまま返す（手書きテナント WHERE を足さない — 可視範囲は RLS）", async () => {
    rows = [
      {
        linkId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        contentId: "11111111-1111-4111-8111-111111111111",
        title: "出稿コンテンツ A",
        schoolId: "22222222-2222-4222-8222-222222222222",
        linkedAt: new Date(0),
      },
    ];
    expect(await listLinkedContents(fakeTx(), CONTRACT_ID)).toEqual(rows);
  });
});
