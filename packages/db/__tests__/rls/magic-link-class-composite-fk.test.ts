import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #204 (#73 横展開, 最終): magic_links.class_id の cross-tenant write 整合を composite FK で
 * DB 強制することを検証する (#203/#207 と同方針)。
 *
 * owner 接続 (BYPASSRLS) で school_id を食い違わせた発行が FK 違反になること、class_id NULL の
 * 旧・保護者リンクは MATCH SIMPLE で検査スキップされること、正常系が書けることを確認する。
 */
describeOrSkip("#204 magic_links.class_id composite FK cross-tenant integrity", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    classA = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, academic_year, name, grade)
        VALUES (${fx.schoolA}, 2026, '1-A', 1) RETURNING id
      `
    )[0].id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("class が別テナントだとクラスリンク発行が composite FK 違反", async () => {
    // class_id は school A の classA だが school_id を school B にすり替える。
    await expect(
      sql`
        INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
        VALUES (${fx.schoolB}, ${classA}, 'mlcfk-cross', now() + interval '30 days')
      `,
    ).rejects.toThrow(/fk_magic_links_class|violates foreign key/i);
  });

  it("正常系: class と school_id が一致すればクラスリンクを発行できる", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
      VALUES (${fx.schoolA}, ${classA}, 'mlcfk-ok', now() + interval '30 days')
      RETURNING id
    `;
    expect(row.id).toBeTruthy();
  });

  it("class_id NULL の旧・保護者リンクは FK 検査をスキップ (MATCH SIMPLE) し発行できる", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO magic_links (school_id, token_hash, expires_at)
      VALUES (${fx.schoolB}, 'mlcfk-null', now() + interval '30 days')
      RETURNING id
    `;
    expect(row.id).toBeTruthy();
  });

  it("composite FK fk_magic_links_class が存在し、旧・単純 FK は消えている", async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'magic_links'::regclass AND contype = 'f'
        AND conname IN ('fk_magic_links_class', 'magic_links_class_id_classes_id_fk')
    `;
    const names = rows.map((r) => r.conname);
    expect(names).toContain("fk_magic_links_class");
    expect(names).not.toContain("magic_links_class_id_classes_id_fk");
  });
});
