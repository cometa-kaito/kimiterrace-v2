import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VECTOR_DIM } from "../../src/_shared/pgvector.js";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  listPendingEmbeddingVersions,
  saveContentEmbedding,
} from "../../src/queries/embedding-batch.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F06 (#398, ADR-007): embedding 生成バッチの DB クエリ層を実 PG（RLS 込み）で検証する。
 *
 * 核心リスク（ルール2 / ルール4）:
 * - 公開中（active publish）かつ embedding 未生成のみ抽出し、下書き / unpublish 済 / 生成済を除外する
 * - **A 校バッチが B 校 version を読めない / 書けない**（テナント越境を RLS が DB レベルで止める）
 * - 書戻しは `updated_at` を明示更新し（ルール1）、`updated_by` は null（システムバッチ）
 *
 * 検証は **非 BYPASSRLS の kimiterrace_app へ降格**して行う（superuser のままだと RLS が効かず vacuous）。
 * DATABASE_URL 未設定ならローカルは skip、CI（実 PG16 + pgvector）で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/** {index: value} から VECTOR_DIM 次元のベクトルを作る（未指定は 0）。 */
function vec(entries: Record<number, number>): number[] {
  const a = new Array<number>(VECTOR_DIM).fill(0);
  for (const k of Object.keys(entries)) {
    a[Number(k)] = entries[Number(k)];
  }
  return a;
}

describeOrSkip("F06 embedding バッチ クエリ層 (RLS / 公開中 / 未生成)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ schoolId: fx.schoolB, role: "school_admin" as const });

  // A 校の抽出対象（公開中・未生成）。除外シナリオ（生成済 / 下書き / unpublish 済）は seed のみで
  // 変数に束ねない（listPending が pendingA だけを返すことで除外を証明する）。
  let pendingA: { contentId: string; versionId: string };
  // B 校: 公開中・未生成（A から不可視であるべき）
  let pendingB: { contentId: string; versionId: string };

  /** content + content_version(+embedding) + publish 状態を 1 件投入する（superuser, RLS バイパス）。 */
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
    const snapshot = JSON.stringify({ title: opts.title, body: "本文" });
    let versionId: string;
    if (opts.embedding === null) {
      const [v] = await raw<{ id: string }[]>`
        INSERT INTO content_versions (school_id, content_id, version, snapshot, embedding, created_by)
        VALUES (${opts.school}, ${c.id}, 1, ${snapshot}::jsonb, NULL, ${opts.user})
        RETURNING id
      `;
      versionId = v.id;
    } else {
      const literal = `[${opts.embedding.join(",")}]`;
      const [v] = await raw<{ id: string }[]>`
        INSERT INTO content_versions (school_id, content_id, version, snapshot, embedding, created_by)
        VALUES (${opts.school}, ${c.id}, 1, ${snapshot}::jsonb, ${literal}::vector, ${opts.user})
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
    pendingA = await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "pendingA",
      embedding: null,
      publish: "active",
    });
    // 公開中・生成済（embedding あり）→ 未生成ではないので除外。
    await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "embeddedA",
      embedding: vec({ 0: 1 }),
      publish: "active",
    });
    // 下書き（publish 無し）→ 公開中ではないので除外。
    await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "draftA",
      embedding: null,
      publish: "none",
    });
    // unpublish 済（unpublished_at あり）→ 公開中ではないので除外。
    await seedDoc({
      school: fx.schoolA,
      user: fx.userA,
      title: "unpubA",
      embedding: null,
      publish: "unpublished",
    });
    pendingB = await seedDoc({
      school: fx.schoolB,
      user: fx.userB,
      title: "pendingB",
      embedding: null,
      publish: "active",
    });
    // updated_at の明示更新を決定的に検証するため、対象行の監査時刻を 1 時間過去に倒す
    // (JS Date を timestamptz に bind しない、DB 側 now()-interval で算出: [[pg-date-bind-enum-insert]])。
    await raw`
      UPDATE content_versions
      SET created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'
      WHERE id = ${pendingA.versionId}
    `;
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("A context: 公開中・embedding 未生成のみ返す (生成済 / 下書き / unpublish 済を除外)", async () => {
    const rows = await withTenantContext(db, ctxA(), (tx) => listPendingEmbeddingVersions(tx), APP);
    expect(rows.map((r) => r.versionId)).toEqual([pendingA.versionId]);
    // snapshot が往復する (埋め込みテキスト生成用)。
    expect(rows[0]?.snapshot).toMatchObject({ title: "pendingA" });
  });

  it("テナント分離: A context から B 校の公開中・未生成 version は見えない (核心リスク)", async () => {
    const rows = await withTenantContext(db, ctxA(), (tx) => listPendingEmbeddingVersions(tx), APP);
    expect(rows.map((r) => r.versionId)).not.toContain(pendingB.versionId);
    // 逆向き: B context は B のみ・A は見えない。
    const rowsB = await withTenantContext(
      db,
      ctxB(),
      (tx) => listPendingEmbeddingVersions(tx),
      APP,
    );
    expect(rowsB.map((r) => r.versionId)).toEqual([pendingB.versionId]);
  });

  it("A context: embedding 書戻しは 1 行更新し updated_at を明示更新・updated_by=null (ルール1)", async () => {
    const n = await withTenantContext(
      db,
      ctxA(),
      (tx) => saveContentEmbedding(tx, pendingA.versionId, vec({ 1: 1 })),
      APP,
    );
    expect(n).toBe(1);
    // superuser で実体を確認 (RLS バイパス、独立検証)。
    const [row] = await raw<{ has_emb: boolean; updated_by: string | null; bumped: boolean }[]>`
      SELECT embedding IS NOT NULL AS has_emb,
             updated_by,
             updated_at > created_at AS bumped
      FROM content_versions WHERE id = ${pendingA.versionId}
    `;
    expect(row.has_emb).toBe(true);
    expect(row.updated_by).toBeNull();
    expect(row.bumped).toBe(true);
    // 生成済になったので listPending に出なくなる (resume 安全 / 再生成しない)。
    const rows = await withTenantContext(db, ctxA(), (tx) => listPendingEmbeddingVersions(tx), APP);
    expect(rows.map((r) => r.versionId)).not.toContain(pendingA.versionId);
  });

  it("テナント分離: A context から B 校 version への書戻しは 0 行 (越境 write を RLS が弾く、核心リスク)", async () => {
    const n = await withTenantContext(
      db,
      ctxA(),
      (tx) => saveContentEmbedding(tx, pendingB.versionId, vec({ 2: 1 })),
      APP,
    );
    expect(n).toBe(0);
    // B の version は依然 embedding 未生成のまま (superuser 独立検証)。
    const [row] = await raw<{ has_emb: boolean }[]>`
      SELECT embedding IS NOT NULL AS has_emb FROM content_versions WHERE id = ${pendingB.versionId}
    `;
    expect(row.has_emb).toBe(false);
  });
});
