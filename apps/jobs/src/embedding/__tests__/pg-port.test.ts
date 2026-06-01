import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F06 (#398): createPgEmbeddingPort の配線を unit で固定する。
 *
 * RLS / SQL の実挙動 (テナント分離・公開中のみ・updated_at) は packages/db の実 PG 結合テスト
 * (embedding-batch.test.ts) が担保する。ここはアダプタ固有の配線のみ検証する:
 *  - 各 I/O が `withTenantContext(db, ctx, ..., {appRole})` で校スコープを張ること
 *  - listPending がクエリ結果をそのまま透過すること
 *  - saveEmbedding が影響行数 1 以外で throw すること (越境書込み / 不在の遮断)
 *
 * `@kimiterrace/db` を丸ごとモックする。`vi.mock` は import 上にホイストされるため、参照する
 * スパイは `vi.hoisted` で先に初期化する (TDZ 回避)。
 */

const mocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(),
  listPendingEmbeddings: vi.fn(),
  saveContentEmbedding: vi.fn(),
}));

vi.mock("@kimiterrace/db", () => ({
  withTenantContext: mocks.withTenantContext,
  listPendingEmbeddings: mocks.listPendingEmbeddings,
  saveContentEmbedding: mocks.saveContentEmbedding,
}));

import { createPgEmbeddingPort } from "../pg-port.js";

// withTenantContext の代役: コールバックに sentinel tx を渡して結果を返す
// (= クエリスパイが sentinel tx で呼ばれることを観測できる)。
const SENTINEL_TX = { __tx: true } as const;
const DB = { __db: true } as never;
const CTX = { schoolId: "school-A", role: "school_admin" as const };

beforeEach(() => {
  mocks.withTenantContext.mockReset();
  mocks.listPendingEmbeddings.mockReset();
  mocks.saveContentEmbedding.mockReset();
  mocks.withTenantContext.mockImplementation(
    async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(SENTINEL_TX),
  );
});

describe("createPgEmbeddingPort", () => {
  it("listPending: 校スコープ tx でクエリを呼び結果を透過する", async () => {
    const rows = [{ versionId: "v1", snapshot: { title: "t" } }];
    mocks.listPendingEmbeddings.mockResolvedValue(rows);

    const port = createPgEmbeddingPort(DB, CTX, { appRole: "kimiterrace_app" });
    const result = await port.listPending();

    expect(result).toBe(rows);
    expect(mocks.listPendingEmbeddings).toHaveBeenCalledWith(SENTINEL_TX);
    // withTenantContext に db / ctx / appRole が渡ること (RLS 校スコープ)。
    expect(mocks.withTenantContext).toHaveBeenCalledWith(DB, CTX, expect.any(Function), {
      appRole: "kimiterrace_app",
    });
  });

  it("saveEmbedding: 影響 1 行なら成功し校スコープ tx でクエリを呼ぶ", async () => {
    mocks.saveContentEmbedding.mockResolvedValue(1);
    const emb = [0.1, 0.2, 0.3];

    const port = createPgEmbeddingPort(DB, CTX, { appRole: "kimiterrace_app" });
    await expect(port.saveEmbedding("v1", emb)).resolves.toBeUndefined();

    expect(mocks.saveContentEmbedding).toHaveBeenCalledWith(SENTINEL_TX, "v1", emb);
  });

  it("saveEmbedding: 影響 0 行 (スコープ外/不在) は throw する", async () => {
    mocks.saveContentEmbedding.mockResolvedValue(0);

    const port = createPgEmbeddingPort(DB, CTX, { appRole: "kimiterrace_app" });
    await expect(port.saveEmbedding("v-other", [0.1])).rejects.toThrow(/0 行更新/);
  });

  it("appRole 未指定なら withTenantContext options は空 (本番 = 既に kimiterrace_app 接続)", async () => {
    mocks.listPendingEmbeddings.mockResolvedValue([]);

    const port = createPgEmbeddingPort(DB, CTX);
    await port.listPending();

    expect(mocks.withTenantContext).toHaveBeenCalledWith(DB, CTX, expect.any(Function), {});
  });
});
