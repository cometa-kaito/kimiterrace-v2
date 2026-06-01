import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VECTOR_DIM } from "../../src/_shared/pgvector.js";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getRelevantPublishedContent } from "../../src/queries/rag-search.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F06 (#364, ADR-028): RAG 検索 getRelevantPublishedContent を実 PG (RLS 込み) で検証する。
 *
 * - 公開中 (active publish) のみを cosine 距離の近い順に返すこと
 * - 下書き (publish 無し) / unpublish 済 / embedding NULL を除外すること
 * - school_id を書かず RLS でテナント分離されること (他校の公開中コンテンツが漏れない=核心リスク)
 *
 * DATABASE_URL 未設定ならローカルは skip、CI (実 PG16 + pgvector) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/** {index: value} から VECTOR_DIM 次元のベクトルを作る (未指定は 0)。 */
function vec(entries: Record<number, number>): number[] {
  const a = new Array<number>(VECTOR_DIM).fill(0);
  for (const k of Object.keys(entries)) {
    a[Number(k)] = entries[Number(k)];
  }
  return a;
}

describeOrSkip("F06 RAG 検索 getRelevantPublishedContent (pgvector / RLS / 公開中)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // query にほぼ一致 (near) → 中間 (mid) → 遠い (far) の順になるよう直交基底で作る。
  const query = vec({ 0: 1, 1: 0.3 });

  let near: { contentId: string; versionId: string };
  let mid: { contentId: string; versionId: string };
  let far: { contentId: string; versionId: string };
  let unpub: { contentId: string; versionId: string };
  let nullEmb: { contentId: string; versionId: string };
  let bDoc: { contentId: string; versionId: string };

  const ctxA = () => ({ schoolId: fx.schoolA, role: "student" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "student" as const });

  /** content + content_version(+embedding) + publish 状態を 1 件投入する (superuser, RLS バイパス)。 */
  async function seedDoc(opts: {
    school: string;
    user: string;
    title: string;
    embedding: number[] | null;
    publish: "active" | "unpublished" | "none";
  }): Promise<{ contentId: string; versionId: string }> {
    const status = opts.publish === "active" ? "published" : "draft";
    const [c] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${opts.school}, ${opts.title}, '本文', 'school', ${status}, ${opts.user})
      RETURNING id
    `;
    let versionId: string;
    if (opts.embedding === null) {
      const [v] = await raw<{ id: string }[]>`
        INSERT INTO content_versions (school_id, content_id, version, snapshot, embedding, created_by)
        VALUES (${opts.school}, ${c.id}, 1, '{}'::jsonb, NULL, ${opts.user})
        RETURNING id
      `;
      versionId = v.id;
    } else {
      const literal = `[${opts.embedding.join(",")}]`;
      const [v] = await raw<{ id: string }[]>`
        INSERT INTO content_versions (school_id, content_id, version, snapshot, embedding, created_by)
        VALUES (${opts.school}, ${c.id}, 1, '{}'::jsonb, ${literal}::vector, ${opts.user})
        RETURNING id
      `;
      versionId = v.id;
    }
    if (opts.publish === "active") {
      await raw`
        INSERT INTO publishes (school_id, content_id, version_id)
        VALUES (${opts.school}, ${c.id}, ${versionId})
      `;
    } else if (opts.publish === "unpublished") {
      await raw`
        INSERT INTO publishes (school_id, content_id, version_id, unpublished_at)
        VALUES (${opts.school}, ${c.id}, ${versionId}, now())
      `;
    }
    return { contentId: c.id, versionId };
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    near = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "near",
      embedding: vec({ 0: 1 }),
      publish: "active",
    });
    mid = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "mid",
      embedding: vec({ 1: 1 }),
      publish: "active",
    });
    far = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "far",
      embedding: vec({ 2: 1 }),
      publish: "active",
    });
    // 最も近い embedding を持つが「公開していない」→ 除外されるべき (下書き)。
    unpub = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "unpub",
      embedding: vec({ 0: 1 }),
      publish: "none",
    });
    // 公開中だが embedding 未生成 (NULL) → 除外されるべき。
    nullEmb = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "nullemb",
      embedding: null,
      publish: "active",
    });
    // 別校 B の公開中 (query に最も近い embedding) → A からは不可視であるべき。
    bDoc = await seedDoc({
      school: fx.schoolB,
      user: fx.userB,
      title: "bdoc",
      embedding: vec({ 0: 1 }),
      publish: "active",
    });
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("A context: 公開中のみを近い順に返す (下書き・NULL embedding を除外)", async () => {
    const res = await withTenantContext(
      db,
      ctxA(),
      (tx) => getRelevantPublishedContent(tx, query, { limit: 10 }),
      APP,
    );
    expect(res.map((r) => r.contentId)).toEqual([near.contentId, mid.contentId, far.contentId]);
    expect(res.map((r) => r.contentId)).not.toContain(unpub.contentId);
    expect(res.map((r) => r.contentId)).not.toContain(nullEmb.contentId);
    // 類似度は降順
    expect(res[0].similarity).toBeGreaterThan(res[1].similarity);
    expect(res[1].similarity).toBeGreaterThan(res[2].similarity);
    // near は query にほぼ一致 → 高い類似度、version/title も正しい射影
    expect(res[0].similarity).toBeGreaterThan(0.9);
    expect(res[0].versionId).toBe(near.versionId);
    expect(res[0].title).toBe("near");
  });

  it("limit で top-k にクランプ", async () => {
    const res = await withTenantContext(
      db,
      ctxA(),
      (tx) => getRelevantPublishedContent(tx, query, { limit: 2 }),
      APP,
    );
    expect(res.map((r) => r.contentId)).toEqual([near.contentId, mid.contentId]);
  });

  it("テナント分離: A からは B の公開中コンテンツが見えない", async () => {
    const res = await withTenantContext(
      db,
      ctxA(),
      (tx) => getRelevantPublishedContent(tx, query, { limit: 10 }),
      APP,
    );
    expect(res.map((r) => r.contentId)).not.toContain(bDoc.contentId);
  });

  it("テナント分離: B からは自校のみ (A は見えない)", async () => {
    const res = await withTenantContext(
      db,
      ctxB(),
      (tx) => getRelevantPublishedContent(tx, query, { limit: 10 }),
      APP,
    );
    expect(res.map((r) => r.contentId)).toEqual([bDoc.contentId]);
    expect(res.map((r) => r.contentId)).not.toContain(near.contentId);
  });

  it("deny-by-default: 空コンテキストは 0 件", async () => {
    const res = await withTenantContext(
      db,
      {},
      (tx) => getRelevantPublishedContent(tx, query, { limit: 10 }),
      APP,
    );
    expect(res).toEqual([]);
  });

  it("embedding 次元が不正なら RangeError (クエリ発行前に弾く)", async () => {
    await expect(getRelevantPublishedContent(db, [1, 2, 3])).rejects.toThrow(RangeError);
  });
});
