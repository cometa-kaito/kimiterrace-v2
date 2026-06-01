import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VECTOR_DIM } from "../../src/_shared/pgvector.js";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  listPendingEmbeddingVersions,
  saveContentEmbedding,
} from "../../src/queries/embedding-batch.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F06 (#398, ADR-007): embedding 生成バッチの RLS クエリ層を実 PG (RLS 込み) で検証する。
 *
 * - listPendingEmbeddingVersions: 公開中 (active publish) かつ embedding NULL のみ返す
 *   (NOT NULL / 下書き / unpublish 済を除外)
 * - テナント分離 (read): school_id を書かず RLS で自校のみ (他校の pending が漏れない=核心リスク)
 * - saveContentEmbedding: embedding を保存し updated_at 更新・updated_by を null にする (ルール1)
 * - テナント分離 (write): 他校 version の id を渡しても RLS USING で 0 行 (越境書込防止=核心リスク、ルール2)
 *
 * いずれも `school_admin` context で呼ぶ (port と同条件、`system_admin` だと full_access が越境)。
 * DATABASE_URL 未設定ならローカルは skip、CI (実 PG16 + pgvector) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/** VECTOR_DIM 次元のベクトル ({index: value}, 未指定は 0)。 */
function vec(entries: Record<number, number>): number[] {
  const a = new Array<number>(VECTOR_DIM).fill(0);
  for (const k of Object.keys(entries)) {
    a[Number(k)] = entries[Number(k)];
  }
  return a;
}

describeOrSkip("F06 embedding バッチ クエリ層 (RLS / 公開中 / 未生成 / 越境書込防止)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  let aPending1: string;
  let aPending2: string;
  let aSaveTarget: string;
  let aHasEmb: string;
  let aDraft: string;
  let aUnpub: string;
  let bPending: string;

  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  /** content + content_version(+embedding/+古い updated_at) + publish 状態を 1 件投入する (superuser)。 */
  async function seedVersion(opts: {
    school: string;
    user: string;
    title: string;
    embedding: number[] | null;
    publish: "active" | "unpublished" | "none";
  }): Promise<string> {
    const status = opts.publish === "active" ? "published" : "draft";
    const [c] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${opts.school}, ${opts.title}, '本文', 'school', ${status}, ${opts.user})
      RETURNING id
    `;
    // updated_at を 1 日前に固定し、save 後の更新 (now()) と区別できるようにする。updated_by も
    // 非 null で入れておき、save 後に null へ落ちることを検証する (rag-search の seedDoc と同じく
    // embedding の有無で INSERT を分岐させる)。
    let v: { id: string };
    if (opts.embedding === null) {
      [v] = await raw<{ id: string }[]>`
        INSERT INTO content_versions
          (school_id, content_id, version, snapshot, embedding, created_by, updated_by, updated_at)
        VALUES (${opts.school}, ${c.id}, 1, '{}'::jsonb, NULL, ${opts.user}, ${opts.user},
          now() - interval '1 day')
        RETURNING id
      `;
    } else {
      const literal = `[${opts.embedding.join(",")}]`;
      [v] = await raw<{ id: string }[]>`
        INSERT INTO content_versions
          (school_id, content_id, version, snapshot, embedding, created_by, updated_by, updated_at)
        VALUES (${opts.school}, ${c.id}, 1, '{}'::jsonb, ${literal}::vector, ${opts.user},
          ${opts.user}, now() - interval '1 day')
        RETURNING id
      `;
    }
    if (opts.publish === "active") {
      await raw`
        INSERT INTO publishes (school_id, content_id, version_id)
        VALUES (${opts.school}, ${c.id}, ${v.id})
      `;
    } else if (opts.publish === "unpublished") {
      await raw`
        INSERT INTO publishes (school_id, content_id, version_id, unpublished_at)
        VALUES (${opts.school}, ${c.id}, ${v.id}, now())
      `;
    }
    return v.id;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    // school A: 公開中・未生成 (= pending) を 3 件
    aPending1 = await seedVersion({
      school: fx.schoolA,
      user: fx.userA,
      title: "pending1",
      embedding: null,
      publish: "active",
    });
    aPending2 = await seedVersion({
      school: fx.schoolA,
      user: fx.userA,
      title: "pending2",
      embedding: null,
      publish: "active",
    });
    aSaveTarget = await seedVersion({
      school: fx.schoolA,
      user: fx.userA,
      title: "save-target",
      embedding: null,
      publish: "active",
    });
    // 除外されるべき 3 種
    aHasEmb = await seedVersion({
      school: fx.schoolA,
      user: fx.userA,
      title: "has-emb",
      embedding: vec({ 0: 1 }), // 既に embedding あり → 再生成しない
      publish: "active",
    });
    aDraft = await seedVersion({
      school: fx.schoolA,
      user: fx.userA,
      title: "draft",
      embedding: null,
      publish: "none", // 下書き (active publish 無し)
    });
    aUnpub = await seedVersion({
      school: fx.schoolA,
      user: fx.userA,
      title: "unpub",
      embedding: null,
      publish: "unpublished", // 公開停止済
    });
    // school B: 公開中・未生成 (A からは不可視であるべき)
    bPending = await seedVersion({
      school: fx.schoolB,
      user: fx.userB,
      title: "b-pending",
      embedding: null,
      publish: "active",
    });
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  async function pendingIds(ctx: ReturnType<typeof ctxA>): Promise<string[]> {
    const rows = await withTenantContext(db, ctx, (tx) => listPendingEmbeddingVersions(tx), APP);
    return rows.map((r) => r.versionId).sort();
  }

  it("A context: 公開中・embedding 未生成のみ (NOT NULL / 下書き / unpublish を除外)", async () => {
    const ids = await pendingIds(ctxA());
    expect(ids).toEqual([aPending1, aPending2, aSaveTarget].sort());
    expect(ids).not.toContain(aHasEmb);
    expect(ids).not.toContain(aDraft);
    expect(ids).not.toContain(aUnpub);
  });

  it("テナント分離 (read): A は B の pending を見ない / B は自校のみ", async () => {
    const aIds = await pendingIds(ctxA());
    expect(aIds).not.toContain(bPending);
    const bIds = await pendingIds(ctxB());
    expect(bIds).toEqual([bPending]);
  });

  it("deny-by-default: 空コンテキストは listPending 0 件 / save 0 行", async () => {
    const rows = await withTenantContext(db, {}, (tx) => listPendingEmbeddingVersions(tx), APP);
    expect(rows).toEqual([]);
    const n = await withTenantContext(
      db,
      {},
      (tx) => saveContentEmbedding(tx, aPending1, vec({ 0: 1 })),
      APP,
    );
    expect(n).toBe(0);
  });

  it("saveContentEmbedding: embedding 保存 + updated_at 更新 + updated_by を null (ルール1)", async () => {
    const before = await raw<{ updated_at: Date }[]>`
      SELECT updated_at FROM content_versions WHERE id = ${aSaveTarget}
    `;
    await raw`RESET ROLE`;

    const n = await withTenantContext(
      db,
      ctxA(),
      (tx) => saveContentEmbedding(tx, aSaveTarget, vec({ 0: 1, 5: 0.5 })),
      APP,
    );
    expect(n).toBe(1);

    const [row] = await raw<{ has_emb: boolean; updated_by: string | null; updated_at: Date }[]>`
      SELECT embedding IS NOT NULL AS has_emb, updated_by, updated_at
      FROM content_versions WHERE id = ${aSaveTarget}
    `;
    expect(row.has_emb).toBe(true);
    // updated_by はシステムバッチなので null (作成時の userA を上書き)
    expect(row.updated_by).toBeNull();
    // updated_at は now() で更新され、seed の 1 日前より新しい
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(
      new Date(before[0].updated_at).getTime(),
    );
    // 生成済みになったので pending から外れる
    const ids = await pendingIds(ctxA());
    expect(ids).not.toContain(aSaveTarget);
  });

  it("テナント分離 (write): A context から B version を保存しても 0 行・B は NULL のまま (ルール2)", async () => {
    const n = await withTenantContext(
      db,
      ctxA(),
      (tx) => saveContentEmbedding(tx, bPending, vec({ 0: 1 })),
      APP,
    );
    expect(n).toBe(0);

    await raw`RESET ROLE`;
    const [row] = await raw<{ has_emb: boolean }[]>`
      SELECT embedding IS NOT NULL AS has_emb FROM content_versions WHERE id = ${bPending}
    `;
    expect(row.has_emb).toBe(false);
  });

  it("embedding 次元が不正なら RangeError (クエリ発行前に弾く)", async () => {
    await expect(
      withTenantContext(db, ctxA(), (tx) => saveContentEmbedding(tx, aPending1, [1, 2, 3]), APP),
    ).rejects.toThrow(RangeError);
  });
});
