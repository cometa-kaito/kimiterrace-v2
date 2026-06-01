import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VECTOR_DIM } from "../../src/_shared/pgvector.js";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { DEFAULT_TOP_K, getRelevantChunks } from "../../src/queries/rag.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F06 (S1): RAG 検索クエリ getRelevantChunks を実 PG (RLS + pgvector) で検証する。
 *
 * - pgvector cosine 距離 (`<=>`) で公開中コンテンツを距離昇順 top-k 取得できること
 * - 公開中 (active publish) かつ embedding 生成済の版のみが根拠候補になること
 * - テナント分離は RLS (tenant_isolation) が DB レベルで強制し、別校の根拠が漏れないこと
 * - deny-by-default (空コンテキストは 0 件) / 次元検証
 */
describeOrSkip("F06 RAG getRelevantChunks (pgvector top-k / RLS / published)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "teacher" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const });

  /** dim 指定だけ非ゼロにした VECTOR_DIM 次元ベクトルを作る。 */
  function vec(nonZero: Record<number, number>): number[] {
    const a = new Array<number>(VECTOR_DIM).fill(0);
    for (const [i, v] of Object.entries(nonZero)) {
      a[Number(i)] = v;
    }
    return a;
  }
  const toLiteral = (a: number[]): string => `[${a.join(",")}]`;

  // クエリ Q = dim0 方向の単位ベクトル。
  const Q = vec({ 0: 1 });
  // 距離: near(同方向, 0) < mid(45°, ≈0.293) < far(直交, 1)。
  const NEAR = vec({ 0: 1 });
  const MID = vec({ 0: 1, 1: 1 });
  const FAR = vec({ 1: 1 });

  /**
   * 公開中 (active publish) の content_version を 1 件 seed する。superuser 接続で school_id を
   * 明示投入し (BYPASSRLS)、後段の getRelevantChunks は kimiterrace_app + RLS で読む。
   * @returns 作成した content_id / version_id
   */
  async function seedPublishedChunk(
    schoolId: string,
    createdBy: string,
    title: string,
    body: string,
    embedding: number[] | null,
    opts: { active?: boolean } = {},
  ): Promise<{ contentId: string; versionId: string }> {
    const active = opts.active ?? true;
    const [content] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${schoolId}, ${title}, ${body}, 'school', 'published', ${createdBy})
      RETURNING id
    `;
    const snapshot = JSON.stringify({
      title,
      body,
      publishScope: "school",
      status: "published",
      targets: null,
    });
    const [version] = embedding
      ? await raw<{ id: string }[]>`
          INSERT INTO content_versions
            (school_id, content_id, version, snapshot, embedding, created_by)
          VALUES
            (${schoolId}, ${content.id}, 1, ${snapshot}::jsonb, ${toLiteral(embedding)}::vector,
             ${createdBy})
          RETURNING id
        `
      : await raw<{ id: string }[]>`
          INSERT INTO content_versions
            (school_id, content_id, version, snapshot, embedding, created_by)
          VALUES
            (${schoolId}, ${content.id}, 1, ${snapshot}::jsonb, NULL, ${createdBy})
          RETURNING id
        `;
    // active=false は「publish が無い」= 未公開版 (draft) を表現する。
    if (active) {
      await raw`
        INSERT INTO publishes (school_id, content_id, version_id, created_by)
        VALUES (${schoolId}, ${content.id}, ${version.id}, ${createdBy})
      `;
    }
    return { contentId: content.id, versionId: version.id };
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM publishes`;
    await raw`DELETE FROM content_versions`;
    await raw`DELETE FROM contents`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("公開中コンテンツを距離昇順 (近い順) で top-k 返す", async () => {
    const far = await seedPublishedChunk(fx.schoolA, fx.userA, "遠い", "far body", FAR);
    const near = await seedPublishedChunk(fx.schoolA, fx.userA, "近い", "near body", NEAR);
    const mid = await seedPublishedChunk(fx.schoolA, fx.userA, "中間", "mid body", MID);

    const rows = await withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, Q), APP);

    expect(rows.map((r) => r.contentId)).toEqual([near.contentId, mid.contentId, far.contentId]);
    // 距離は単調非減少 + 最近傍は ≈0 (Q == NEAR)。
    expect(rows[0].distance).toBeCloseTo(0, 5);
    expect(rows[0].distance).toBeLessThanOrEqual(rows[1].distance);
    expect(rows[1].distance).toBeLessThanOrEqual(rows[2].distance);
    // snapshot から本文を射影する。
    expect(rows[0].title).toBe("近い");
    expect(rows[0].body).toBe("near body");
    expect(rows[0].versionId).toBe(near.versionId);
  });

  it("limit で件数を絞る (近い順に limit 件)", async () => {
    const far = await seedPublishedChunk(fx.schoolA, fx.userA, "遠い", "far", FAR);
    const near = await seedPublishedChunk(fx.schoolA, fx.userA, "近い", "near", NEAR);
    const mid = await seedPublishedChunk(fx.schoolA, fx.userA, "中間", "mid", MID);

    const rows = await withTenantContext(
      db,
      ctxA(),
      (tx) => getRelevantChunks(tx, Q, { limit: 2 }),
      APP,
    );
    expect(rows.map((r) => r.contentId)).toEqual([near.contentId, mid.contentId]);
    expect(rows.map((r) => r.contentId)).not.toContain(far.contentId);
  });

  it("embedding が NULL の公開版は除外する (S2 未処理の版を根拠にしない)", async () => {
    const withEmb = await seedPublishedChunk(fx.schoolA, fx.userA, "あり", "has emb", NEAR);
    await seedPublishedChunk(fx.schoolA, fx.userA, "なし", "no emb", null);

    const rows = await withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, Q), APP);
    expect(rows.map((r) => r.contentId)).toEqual([withEmb.contentId]);
  });

  it("公開中でない版 (active publish 無し) は除外する", async () => {
    const published = await seedPublishedChunk(fx.schoolA, fx.userA, "公開", "pub", NEAR);
    // active=false: embedding はあるが publishes 行が無い (= draft 相当)。
    await seedPublishedChunk(fx.schoolA, fx.userA, "下書き", "draft", NEAR, { active: false });

    const rows = await withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, Q), APP);
    expect(rows.map((r) => r.contentId)).toEqual([published.contentId]);
  });

  it("unpublish 済 (unpublished_at セット) は除外する", async () => {
    const live = await seedPublishedChunk(fx.schoolA, fx.userA, "公開中", "live", NEAR);
    const closed = await seedPublishedChunk(fx.schoolA, fx.userA, "公開停止", "closed", MID);
    await raw`UPDATE publishes SET unpublished_at = now() WHERE content_id = ${closed.contentId}`;

    const rows = await withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, Q), APP);
    expect(rows.map((r) => r.contentId)).toEqual([live.contentId]);
  });

  it("テナント分離: 別校の chunk は返らない (RLS 委譲)", async () => {
    const a = await seedPublishedChunk(fx.schoolA, fx.userA, "A 校掲示", "a body", NEAR);
    const b = await seedPublishedChunk(fx.schoolB, fx.userB, "B 校掲示", "b body", NEAR);

    const aRows = await withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, Q), APP);
    expect(aRows.map((r) => r.contentId)).toEqual([a.contentId]);

    const bRows = await withTenantContext(db, ctxB(), (tx) => getRelevantChunks(tx, Q), APP);
    expect(bRows.map((r) => r.contentId)).toEqual([b.contentId]);
  });

  it("deny-by-default: 空コンテキストは 0 件", async () => {
    await seedPublishedChunk(fx.schoolA, fx.userA, "公開", "pub", NEAR);
    const rows = await withTenantContext(db, {}, (tx) => getRelevantChunks(tx, Q), APP);
    expect(rows).toEqual([]);
  });

  it("embedding 次元が不正なら throw (DB の cryptic error を防ぐ早期検証)", async () => {
    await expect(
      withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, [1, 2, 3]), APP),
    ).rejects.toThrow(/次元が不正/);
  });

  it("DEFAULT_TOP_K を超える公開版があっても既定では上位 DEFAULT_TOP_K 件に制限される", async () => {
    for (let i = 0; i < DEFAULT_TOP_K + 2; i++) {
      // すべて NEAR 方向だが dim2 以降に微小差をつけ、決定的順序 (version_id 二次キー) を壊さない。
      await seedPublishedChunk(fx.schoolA, fx.userA, `c${i}`, `body${i}`, vec({ 0: 1 }));
    }
    const rows = await withTenantContext(db, ctxA(), (tx) => getRelevantChunks(tx, Q), APP);
    expect(rows.length).toBe(DEFAULT_TOP_K);
  });
});
