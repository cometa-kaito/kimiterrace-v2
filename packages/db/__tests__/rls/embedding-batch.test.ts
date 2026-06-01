import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VECTOR_DIM } from "../../src/_shared/pgvector.js";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { listPendingEmbeddings, saveContentEmbedding } from "../../src/queries/embedding-batch.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F06 (#398, ADR-007): embedding 生成バッチの DB クエリ層を実 PG (RLS 込み) で検証する。
 *
 * - listPendingEmbeddings: 公開中 (active publish) かつ embedding NULL のみを返す
 *   (下書き / unpublish 済 / 既生成を除外)、version_id 昇順
 * - saveContentEmbedding: embedding を保存し updated_at を前進・updated_by を null にする (ルール1)
 * - **テナント分離 (ルール2)**: school_id を書かず RLS で自校スコープ。A から B の version を
 *   list も update もできない (= 核心リスク: 他校掲示物の embedding 上書き / 読取)
 * - 次元不正は RangeError (クエリ発行前に弾く、silent drift 防止)
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

describeOrSkip("F06 embedding バッチ DB クエリ (listPending / saveEmbedding / RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // バッチは各校を school_admin に降格した context で回す (#398: system_admin で校列挙 → 校ごと降格)。
  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  let pendingA: { contentId: string; versionId: string };
  let unpublishedA: { contentId: string; versionId: string };
  let draftA: { contentId: string; versionId: string };
  let embeddedA: { contentId: string; versionId: string };
  let pendingB: { contentId: string; versionId: string };

  /**
   * content + content_version(+embedding) + publish 状態を 1 件投入する (superuser, RLS バイパス)。
   * `aged` 指定時は version の created_at/updated_at を 1 日前にし、保存後の updated_at 前進を
   * クロックスキューに依存せず検証できるようにする。
   */
  async function seedDoc(opts: {
    school: string;
    user: string;
    title: string;
    embedding: number[] | null;
    publish: "active" | "unpublished" | "none";
    aged?: boolean;
  }): Promise<{ contentId: string; versionId: string }> {
    const status = opts.publish === "active" ? "published" : "draft";
    const [c] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${opts.school}, ${opts.title}, '本文', 'school', ${status}, ${opts.user})
      RETURNING id
    `;
    const snapshot = JSON.stringify({ title: opts.title, body: "本文" });
    // null を渡すと `NULL::vector` = NULL になるため、embedding 有無で分岐不要。
    const embLiteral = opts.embedding === null ? null : `[${opts.embedding.join(",")}]`;
    // updated_at は aged 指定で 1 日前 (DB 側算出。JS Date を timestamptz に bind しない、
    // postgres@3 の enum-INSERT 直列化罠を回避 — feedback_pg_date_bind_enum_insert)。
    // 同一 fragment の使い回しを避け、列ごとに生成する。
    const ts = () => (opts.aged ? raw`now() - interval '1 day'` : raw`now()`);
    const [v] = await raw<{ id: string }[]>`
      INSERT INTO content_versions
        (school_id, content_id, version, snapshot, embedding, created_by, created_at, updated_at)
      VALUES (
        ${opts.school}, ${c.id}, 1, ${snapshot}::jsonb, ${embLiteral}::vector,
        ${opts.user}, ${ts()}, ${ts()}
      )
      RETURNING id
    `;
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
    return { contentId: c.id, versionId: v.id };
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    // A 校: 公開中・未生成 → listPending に出る (保存対象)。aged で updated_at 前進を検証可能に。
    pendingA = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "pending-A",
      embedding: null,
      publish: "active",
      aged: true,
    });
    // A 校: unpublish 済 → 除外。
    unpublishedA = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "unpublished-A",
      embedding: null,
      publish: "unpublished",
    });
    // A 校: 下書き (publish 無し) → 除外。
    draftA = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "draft-A",
      embedding: null,
      publish: "none",
    });
    // A 校: 公開中だが embedding 既生成 → 除外。
    embeddedA = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "embedded-A",
      embedding: vec({ 0: 1 }),
      publish: "active",
    });
    // B 校: 公開中・未生成 → A からは不可視であるべき (テナント分離)。
    pendingB = await seedDoc({
      school: fx.schoolB,
      user: fx.userB,
      title: "pending-B",
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

  it("listPending: A は公開中・未生成のみ返す (unpublish / 下書き / 既生成 / 他校を除外)", async () => {
    const res = await withTenantContext(db, ctxA(), (tx) => listPendingEmbeddings(tx), APP);
    expect(res.map((r) => r.versionId)).toEqual([pendingA.versionId]);
    const ids = res.map((r) => r.versionId);
    expect(ids).not.toContain(unpublishedA.versionId);
    expect(ids).not.toContain(draftA.versionId);
    expect(ids).not.toContain(embeddedA.versionId);
    expect(ids).not.toContain(pendingB.versionId);
    // snapshot が埋め込みテキスト組み立て用にそのまま返ること。
    expect(res[0].snapshot).toEqual({ title: "pending-A", body: "本文" });
  });

  it("listPending テナント分離: B は自校の未生成のみ (A は見えない)", async () => {
    const res = await withTenantContext(db, ctxB(), (tx) => listPendingEmbeddings(tx), APP);
    expect(res.map((r) => r.versionId)).toEqual([pendingB.versionId]);
    expect(res.map((r) => r.versionId)).not.toContain(pendingA.versionId);
  });

  it("listPending deny-by-default: 空コンテキストは 0 件", async () => {
    const res = await withTenantContext(db, {}, (tx) => listPendingEmbeddings(tx), APP);
    expect(res).toEqual([]);
  });

  it("saveEmbedding: embedding を保存し updated_at 前進・updated_by null (影響 1 行)", async () => {
    const embedding = vec({ 5: 1, 9: 0.5 });
    const affected = await withTenantContext(
      db,
      ctxA(),
      (tx) => saveContentEmbedding(tx, pendingA.versionId, embedding),
      APP,
    );
    expect(affected).toBe(1);

    // superuser で実体を検証 (RLS 非依存に row を読む)。
    const [row] = await raw<
      { embedding: string | null; updated_by: string | null; updated_at: Date; created_at: Date }[]
    >`
      SELECT embedding, updated_by, updated_at, created_at
      FROM content_versions WHERE id = ${pendingA.versionId}
    `;
    expect(row.embedding).not.toBeNull();
    // pgvector はテキスト化すると "[v0,v1,...]"。index 5 と 9 を pin。
    const parsed = JSON.parse(row.embedding as string) as number[];
    expect(parsed).toHaveLength(VECTOR_DIM);
    expect(parsed[5]).toBeCloseTo(1, 6);
    expect(parsed[9]).toBeCloseTo(0.5, 6);
    // システムバッチ書込み: updated_by は null (ルール1)。
    expect(row.updated_by).toBeNull();
    // updated_at を明示更新 (作成時刻 = 1 日前 aged から前進、ルール1)。
    expect(row.updated_at.getTime()).toBeGreaterThan(row.created_at.getTime());

    // 保存後は embedding 非 NULL になり listPending から外れる。
    const after = await withTenantContext(db, ctxA(), (tx) => listPendingEmbeddings(tx), APP);
    expect(after.map((r) => r.versionId)).not.toContain(pendingA.versionId);
  });

  it("saveEmbedding テナント分離: A から B の version は影響 0 行・B の embedding 不変", async () => {
    const before = await raw<{ embedding: string | null }[]>`
      SELECT embedding FROM content_versions WHERE id = ${pendingB.versionId}
    `;
    expect(before[0].embedding).toBeNull();

    const affected = await withTenantContext(
      db,
      ctxA(),
      (tx) => saveContentEmbedding(tx, pendingB.versionId, vec({ 0: 1 })),
      APP,
    );
    // RLS USING が他校行を不可視にするため UPDATE は 0 行 (越境書込み遮断)。
    expect(affected).toBe(0);

    const after = await raw<{ embedding: string | null }[]>`
      SELECT embedding FROM content_versions WHERE id = ${pendingB.versionId}
    `;
    expect(after[0].embedding).toBeNull();
  });

  it("saveEmbedding: 次元不正は RangeError (クエリ発行前に弾く)", async () => {
    await expect(saveContentEmbedding(db, pendingA.versionId, [1, 2, 3])).rejects.toThrow(
      RangeError,
    );
  });
});
