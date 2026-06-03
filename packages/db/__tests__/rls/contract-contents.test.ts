import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * F10 (#46): contract_contents（契約 ⇄ 出稿コンテンツ紐付け）の RLS テスト。
 *
 * 本表は **cross-tenant CRM 中間表**で RLS は `system_admin_full_access` のみ（migration 0020、ADR-019）。
 * 検証ポリシー（CLAUDE.md ルール2 / 非空虚 = vacuous でないこと）:
 *   1. system_admin context で link(INSERT) / select / unlink(DELETE) が成立する。
 *   2. kimiterrace_app に降格した **非 system_admin context（school_admin/teacher/...）では 0 行**
 *      （deny-by-default、tenant_isolation の抜け穴も無い）。
 *   3. **非空虚の裏取り**: BYPASSRLS スーパーユーザー（RESET ROLE）の独立 count で行が実在することを確認
 *      （RLS で隠れているのであって、そもそも 0 件だから 0 だったのではないことを示す）。
 *   4. UNIQUE(contract_id, content_id) で二重紐付けが拒否される。
 *   5. cascade: 契約削除（DELETE contracts）で紐付け行が消える / コンテンツ削除でも消える。
 *   6. 非 system_admin の INSERT は WITH CHECK で拒否される。
 *
 * fixture は 2 校 + system_admin。contents は schoolA / schoolB に 1 件ずつ直接投入（BYPASSRLS）。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("RLS contract_contents（契約 ⇄ 出稿コンテンツ、system_admin 限定）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let contractId: string;
  let contentA: string; // schoolA のコンテンツ
  let contentB: string; // schoolB のコンテンツ（cross-tenant 結合の検証用）

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 広告主 + 契約（cross-tenant CRM）を BYPASSRLS で直接投入。
    const [adv] = await sql<{ id: string }[]>`
      INSERT INTO advertisers (company_name, industry, contact_email)
      VALUES ('紐付けテスト広告主', 'IT', 'sales@example.com')
      RETURNING id
    `;
    const [con] = await sql<{ id: string }[]>`
      INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy)
      VALUES (${adv.id}, 'active', now(), 50000)
      RETURNING id
    `;
    contractId = con.id;
    // テナント表 contents を 2 校分投入（cross-tenant 結合で system_admin が両校のタイトルを引けることの確認用）。
    const [cA] = await sql<{ id: string }[]>`
      INSERT INTO contents (school_id, title, publish_scope, status)
      VALUES (${fx.schoolA}, 'A校の掲示物', 'school', 'published')
      RETURNING id
    `;
    const [cB] = await sql<{ id: string }[]>`
      INSERT INTO contents (school_id, title, publish_scope, status)
      VALUES (${fx.schoolB}, 'B校の掲示物', 'school', 'published')
      RETURNING id
    `;
    contentA = cA.id;
    contentB = cB.id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
    // 各テストを独立させるため contract_contents を毎回クリア（BYPASSRLS）。
    await sql`DELETE FROM contract_contents`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("system_admin: link(INSERT) → select → unlink(DELETE) が一通り成立する", async () => {
    // link
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const rows = await tx<{ id: string }[]>`
        INSERT INTO contract_contents (contract_id, content_id)
        VALUES (${contractId}, ${contentA})
        RETURNING id
      `;
      expect(rows.length).toBe(1);
    });
    // select（cross-tenant 結合: A校・B校のタイトルが system_admin から引ける）
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      // B校コンテンツも link して両校が見えることを確認
      await tx`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentB})`;
      const rows = await tx<{ title: string; school_id: string }[]>`
        SELECT c.title, c.school_id
        FROM contract_contents cc
        JOIN contents c ON c.id = cc.content_id
        WHERE cc.contract_id = ${contractId}
        ORDER BY c.title
      `;
      expect(rows.map((r) => r.title)).toEqual(["A校の掲示物", "B校の掲示物"]);
    });
    // unlink（DELETE で 0 件に戻る）
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      await tx`DELETE FROM contract_contents WHERE contract_id = ${contractId}`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM contract_contents`;
      expect(rows.length).toBe(0);
    });
  });

  it("非 system_admin（school_admin/teacher/student/guardian + app ロール）→ contract_contents は 0 行", async () => {
    // 先に system_admin で 1 件 link しておく（非空虚の前提となる「実在する行」を作る）。
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      await tx`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentA})`;
    });

    // 非空虚の裏取り: BYPASSRLS（RESET ROLE = postgres スーパーユーザー）の独立 count で実在を確認。
    const [{ count }] = await sql<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM contract_contents`;
    expect(Number(count)).toBe(1);

    // 各非 system_admin role + kimiterrace_app では RLS で 0 行に隠れる。
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
        const rows = await tx<{ id: string }[]>`SELECT id FROM contract_contents`;
        expect(rows.length, `role=${role}`).toBe(0);
      });
    }
  });

  it("context 未設定（role 無し）でも 0 行（deny-by-default）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      await tx`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentA})`;
    });
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      // role も school_id も SET しない。
      const rows = await tx<{ id: string }[]>`SELECT id FROM contract_contents`;
      expect(rows.length).toBe(0);
    });
  });

  it("非 system_admin の INSERT は WITH CHECK で拒否される", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentA})`;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("UNIQUE(contract_id, content_id): 同一契約に同一コンテンツの二重紐付けは拒否される", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      await tx`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentA})`;
    });
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
        await tx`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentA})`;
      }),
    ).rejects.toThrow(/duplicate key value|unique/i);
  });

  it("cascade: 契約削除で紐付け行が消える", async () => {
    // 別広告主 + 別契約を BYPASSRLS で作り、その契約に link → 契約削除で link が消えることを確認
    // （fixture の contractId は他テストで使うため、本ケースは専用契約を使う）。
    const [adv] = await sql<{ id: string }[]>`
      INSERT INTO advertisers (company_name) VALUES ('cascade テスト社') RETURNING id
    `;
    const [con] = await sql<{ id: string }[]>`
      INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy)
      VALUES (${adv.id}, 'active', now(), 10000) RETURNING id
    `;
    await sql`INSERT INTO contract_contents (contract_id, content_id) VALUES (${con.id}, ${contentA})`;
    // 実在確認（BYPASSRLS）。
    const [{ count: before }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM contract_contents WHERE contract_id = ${con.id}
    `;
    expect(Number(before)).toBe(1);
    // 契約削除 → ON DELETE CASCADE で紐付けも消える。
    await sql`DELETE FROM contracts WHERE id = ${con.id}`;
    const [{ count: after }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM contract_contents WHERE contract_id = ${con.id}
    `;
    expect(Number(after)).toBe(0);
  });

  it("cascade: コンテンツ削除で紐付け行が消える", async () => {
    // 専用コンテンツ（schoolA）+ link を作り、コンテンツ削除で link が消えることを確認。
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO contents (school_id, title, publish_scope, status)
      VALUES (${fx.schoolA}, '削除されるコンテンツ', 'school', 'published')
      RETURNING id
    `;
    await sql`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${c.id})`;
    const [{ count: before }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM contract_contents WHERE content_id = ${c.id}
    `;
    expect(Number(before)).toBe(1);
    await sql`DELETE FROM contents WHERE id = ${c.id}`;
    const [{ count: after }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM contract_contents WHERE content_id = ${c.id}
    `;
    expect(Number(after)).toBe(0);
  });
});
