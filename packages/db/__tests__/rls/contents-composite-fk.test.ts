import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #204 (#73 横展開): contents ドメインの cross-tenant write 整合を composite FK で DB 強制する
 * ことを検証する。#203 (AI/RAG) と同方針。
 *
 * RLS は read を守るが write のテナント混在は守らない。ここでは **owner 接続 (BYPASSRLS)** で
 * わざと school_id を食い違わせて INSERT し、composite FK が DB レベルで弾くことを確認する。
 * 接続は DATABASE_URL の superuser。SET ROLE しない = RLS をバイパスするため、FK だけが gate。
 */
describeOrSkip("#204 contents composite FK cross-tenant write integrity", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let contentA: string;
  let versionA: string;
  let contentB: string;
  let versionB: string;

  async function seedContent(schoolId: string, userId: string): Promise<[string, string]> {
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${schoolId}, 'お知らせ', '本文', 'school', 'draft', ${userId})
      RETURNING id
    `;
    const [v] = await sql<{ id: string }[]>`
      INSERT INTO content_versions (school_id, content_id, version, snapshot, created_by)
      VALUES (${schoolId}, ${c.id}, 1, '{}'::jsonb, ${userId})
      RETURNING id
    `;
    return [c.id, v.id];
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    [contentA, versionA] = await seedContent(fx.schoolA, fx.userA);
    [contentB, versionB] = await seedContent(fx.schoolB, fx.userB);
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("content_versions: content が別テナントだと composite FK 違反", async () => {
    // content_id は school A の contentA だが school_id を school B にすり替える。
    await expect(
      sql`
        INSERT INTO content_versions (school_id, content_id, version, snapshot, created_by)
        VALUES (${fx.schoolB}, ${contentA}, 2, '{}'::jsonb, ${fx.userB})
      `,
    ).rejects.toThrow(/fk_content_versions_content|violates foreign key/i);
  });

  it("publishes: content が別テナントだと composite FK 違反 (version は整合)", async () => {
    // version_id=versionB は school B 整合だが content_id=contentA は school A → content FK 違反。
    await expect(
      sql`
        INSERT INTO publishes (school_id, content_id, version_id, created_by)
        VALUES (${fx.schoolB}, ${contentA}, ${versionB}, ${fx.userB})
      `,
    ).rejects.toThrow(/fk_publishes_content|violates foreign key/i);
  });

  it("publishes: version が別テナントだと composite FK 違反 (content は整合)", async () => {
    // content_id=contentB は school B 整合だが version_id=versionA は school A → version FK 違反。
    await expect(
      sql`
        INSERT INTO publishes (school_id, content_id, version_id, created_by)
        VALUES (${fx.schoolB}, ${contentB}, ${versionA}, ${fx.userB})
      `,
    ).rejects.toThrow(/fk_publishes_version|violates foreign key/i);
  });

  it("正常系: school_id が親と一致していれば version / publish とも書ける", async () => {
    const [v] = await sql<{ id: string }[]>`
      INSERT INTO content_versions (school_id, content_id, version, snapshot, created_by)
      VALUES (${fx.schoolA}, ${contentA}, 2, '{}'::jsonb, ${fx.userA})
      RETURNING id
    `;
    expect(v.id).toBeTruthy();
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO publishes (school_id, content_id, version_id, created_by)
      VALUES (${fx.schoolA}, ${contentA}, ${versionA}, ${fx.userA})
      RETURNING id
    `;
    expect(p.id).toBeTruthy();
  });

  it("親 UNIQUE(id, school_id) が composite FK の参照先として存在する", async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname IN ('uq_contents_id_school', 'uq_content_versions_id_school')
      ORDER BY conname
    `;
    expect(rows.map((r) => r.conname)).toEqual([
      "uq_content_versions_id_school",
      "uq_contents_id_school",
    ]);
  });
});
