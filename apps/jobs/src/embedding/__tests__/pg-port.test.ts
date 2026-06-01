import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F06 (#398): `createPgEmbeddingPort` の配線ユニットテスト。
 *
 * 本ラッパの責務は「校スコープの RLS context (school_admin + school_id) を張って query 層へ委譲する」
 * ことだけ。実 SQL / 実 RLS テナント分離は packages/db の実 PG テスト
 * (`__tests__/rls/embedding-batch.test.ts`) が担保するため、ここでは @kimiterrace/db を mock し
 * 「context の張り方」と「委譲先・引数」を pin する (フェイクで GCP/PG 不要、ADR-012)。
 */

const { withTenantContext, listPendingEmbeddingVersions, saveContentEmbedding } = vi.hoisted(
  () => ({
    withTenantContext: vi.fn(),
    listPendingEmbeddingVersions: vi.fn(),
    saveContentEmbedding: vi.fn(),
  }),
);

vi.mock("@kimiterrace/db", () => ({
  withTenantContext,
  listPendingEmbeddingVersions,
  saveContentEmbedding,
}));

import { createPgEmbeddingPort } from "../pg-port.js";

// withTenantContext(db, ctx, fn, opts) の代わりに、sentinel tx で fn を実行する mock。
const TX = Symbol("tx");
const DB = Symbol("db") as never;

beforeEach(() => {
  vi.clearAllMocks();
  withTenantContext.mockImplementation(
    async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown, _opts: unknown) => fn(TX),
  );
  listPendingEmbeddingVersions.mockResolvedValue([{ versionId: "v1", snapshot: { title: "a" } }]);
  saveContentEmbedding.mockResolvedValue(1);
});

describe("createPgEmbeddingPort", () => {
  it("listPending: school_admin + school_id の RLS context で listPendingEmbeddingVersions に委譲する", async () => {
    const port = createPgEmbeddingPort({
      db: DB,
      schoolId: "school-A",
      appRole: "kimiterrace_app",
    });

    const res = await port.listPending();

    expect(res).toEqual([{ versionId: "v1", snapshot: { title: "a" } }]);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    const [db, ctx, _fn, opts] = withTenantContext.mock.calls.at(0) ?? [];
    expect(db).toBe(DB);
    // system_admin ではなく school_admin に降格して RLS を実際に効かせる (ルール2)。
    expect(ctx).toEqual({ schoolId: "school-A", role: "school_admin" });
    expect(opts).toEqual({ appRole: "kimiterrace_app" });
    // query 層には tx がそのまま渡る。
    expect(listPendingEmbeddingVersions).toHaveBeenCalledWith(TX);
  });

  it("saveEmbedding: 同じ RLS context で saveContentEmbedding(tx, versionId, embedding) に委譲する", async () => {
    const port = createPgEmbeddingPort({
      db: DB,
      schoolId: "school-A",
      appRole: "kimiterrace_app",
    });
    const embedding = [0.1, 0.2, 0.3];

    await port.saveEmbedding("ver-9", embedding);

    expect(withTenantContext).toHaveBeenCalledTimes(1);
    const [, ctx, , opts] = withTenantContext.mock.calls.at(0) ?? [];
    expect(ctx).toEqual({ schoolId: "school-A", role: "school_admin" });
    expect(opts).toEqual({ appRole: "kimiterrace_app" });
    expect(saveContentEmbedding).toHaveBeenCalledWith(TX, "ver-9", embedding);
  });

  it("appRole 未指定なら options は空 (本番 kimiterrace_app 接続を想定し SET LOCAL ROLE しない)", async () => {
    const port = createPgEmbeddingPort({ db: DB, schoolId: "school-B" });

    await port.listPending();

    const [, , , opts] = withTenantContext.mock.calls.at(0) ?? [];
    expect(opts).toEqual({});
  });

  it("1 ポート = 1 校: listPending と saveEmbedding は別 tx (Vertex 往復を跨がない)", async () => {
    const port = createPgEmbeddingPort({ db: DB, schoolId: "school-A" });

    await port.listPending();
    await port.saveEmbedding("ver-1", [1, 2, 3]);

    // メソッドごとに独立した withTenantContext = 独立した短い tx。
    expect(withTenantContext).toHaveBeenCalledTimes(2);
  });
});
