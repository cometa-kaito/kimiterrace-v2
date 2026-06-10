import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）schema PR の実 PG 検証。
 *
 * `advertisers.portal_company_id` / `contracts.portal_contract_id` / `ads.portal_placement_id`
 * の追加列が **存在し**、各々に張った **UNIQUE index が効く**ことを pin する。これらは portal（商流 SoR・
 * 別リポ）由来 ID の冪等キーで、`POST /api/partner/delivery` が競合キーに upsert する（二重反映しない）。
 *
 * - **nullable + unique**: 既存行・portal 非経由行は null。Postgres の UNIQUE は NULL を互いに distinct と
 *   扱うため、複数行が null 値を持てる（部分 index 不要）。一方、同じ非 NULL の portal_id を 2 行に
 *   入れると UNIQUE 違反になる（冪等キーとしての一意性）。
 * - **列追加のみ**で新規テーブルは無いため、RLS policy は不変（CRM 表は migration 0002 の
 *   `system_admin_full_access` を既に持つ）。本テストは system_admin context で書き込み、列と unique を確認する。
 *
 * 接続は DATABASE_URL の superuser（BYPASSRLS）。検証/seed は raw（BYPASSRLS）、ロジック実行は
 * `SET LOCAL ROLE kimiterrace_app` + role=system_admin に降ろして RLS 二層下で実走させる。
 */
describeOrSkip("Partner K3 schema: portal_*_id 冪等キー列 + UNIQUE (RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // 固定の portal UUID（冪等キー）。
  const PORTAL_CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PORTAL_CONTRACT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PORTAL_PLACEMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
    // CRM 表 + ads を毎テスト初期化（fixture は schools/users のみ）。
    await sql`DELETE FROM ads`;
    await sql`DELETE FROM contracts`;
    await sql`DELETE FROM advertisers`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // system_admin context（CRM 表は system_admin_full_access のみ）で fn を実行。
  function asSystemAdmin<T>(
    fn: (tx: Parameters<Parameters<typeof sql.begin>[0]>[0]) => Promise<T>,
  ) {
    return sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      return fn(tx);
    });
  }

  it("情報スキーマ: 3 列が uuid・nullable で存在する（既存行は null 可）", async () => {
    const rows = await sql<
      { table_name: string; column_name: string; is_nullable: string; data_type: string }[]
    >`
      SELECT table_name, column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE (table_name = 'advertisers' AND column_name = 'portal_company_id')
         OR (table_name = 'contracts'   AND column_name = 'portal_contract_id')
         OR (table_name = 'ads'         AND column_name = 'portal_placement_id')
      ORDER BY table_name, column_name
    `;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.data_type).toBe("uuid");
      expect(r.is_nullable).toBe("YES");
    }
  });

  it("3 つの UNIQUE index が張られている", async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'ux_advertisers_portal_company_id',
        'ux_contracts_portal_contract_id',
        'ux_ads_portal_placement_id'
      )
    `;
    // ASCII 昇順: "ux_ads_" < "ux_advertisers_"（5 文字目 's' < 'v'）< "ux_contracts_"。
    expect(idx.map((r) => r.indexname).sort()).toEqual([
      "ux_ads_portal_placement_id",
      "ux_advertisers_portal_company_id",
      "ux_contracts_portal_contract_id",
    ]);
  });

  it("advertisers.portal_company_id: 同一値の 2 行目は UNIQUE 違反", async () => {
    await asSystemAdmin(async (tx) => {
      await tx`INSERT INTO advertisers (company_name, portal_company_id) VALUES ('社1', ${PORTAL_CO})`;
    });
    await expect(
      asSystemAdmin(async (tx) => {
        await tx`INSERT INTO advertisers (company_name, portal_company_id) VALUES ('社2', ${PORTAL_CO})`;
      }),
    ).rejects.toThrow(/duplicate key value|ux_advertisers_portal_company_id/i);
  });

  it("contracts.portal_contract_id: 同一値の 2 行目は UNIQUE 違反", async () => {
    const advId = await asSystemAdmin(async (tx) => {
      const [a] = await tx<{ id: string }[]>`
        INSERT INTO advertisers (company_name) VALUES ('契約親社') RETURNING id
      `;
      await tx`
        INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy, portal_contract_id)
        VALUES (${a.id}, 'active', now(), 30000, ${PORTAL_CONTRACT})
      `;
      return a.id;
    });
    await expect(
      asSystemAdmin(async (tx) => {
        await tx`
          INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy, portal_contract_id)
          VALUES (${advId}, 'active', now(), 40000, ${PORTAL_CONTRACT})
        `;
      }),
    ).rejects.toThrow(/duplicate key value|ux_contracts_portal_contract_id/i);
  });

  it("ads.portal_placement_id: 同一値の 2 行目は UNIQUE 違反", async () => {
    // ads は school スコープ（hierarchy id 全 null）の最小行で検証。ads は学校テナント表だが
    // system_admin context は system_admin_full_access policy で全校に書ける（運営入稿広告の経路）。
    await asSystemAdmin(async (tx) => {
      await tx`
        INSERT INTO ads (school_id, scope, media_url, media_type, portal_placement_id)
        VALUES (${fx.schoolA}, 'school', 'https://x/1.png', 'image', ${PORTAL_PLACEMENT})
      `;
    });
    await expect(
      asSystemAdmin(async (tx) => {
        await tx`
          INSERT INTO ads (school_id, scope, media_url, media_type, portal_placement_id)
          VALUES (${fx.schoolA}, 'school', 'https://x/2.png', 'image', ${PORTAL_PLACEMENT})
        `;
      }),
    ).rejects.toThrow(/duplicate key value|ux_ads_portal_placement_id/i);
  });

  it("NULL は複数行で許容される（既存行・portal 非経由行）", async () => {
    // 3 表とも portal_id を入れない 2 行が共存できる（UNIQUE は NULL を distinct 扱い）。
    await asSystemAdmin(async (tx) => {
      const [a1] = await tx<{ id: string }[]>`
        INSERT INTO advertisers (company_name) VALUES ('null社1') RETURNING id
      `;
      await tx`INSERT INTO advertisers (company_name) VALUES ('null社2')`;
      await tx`
        INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy)
        VALUES (${a1.id}, 'active', now(), 10000)
      `;
      await tx`
        INSERT INTO contracts (advertiser_id, status, started_at, monthly_fee_jpy)
        VALUES (${a1.id}, 'active', now(), 20000)
      `;
      await tx`
        INSERT INTO ads (school_id, scope, media_url, media_type)
        VALUES (${fx.schoolA}, 'school', 'https://x/a.png', 'image')
      `;
      await tx`
        INSERT INTO ads (school_id, scope, media_url, media_type)
        VALUES (${fx.schoolA}, 'school', 'https://x/b.png', 'image')
      `;
    });

    const [adv] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM advertisers WHERE portal_company_id IS NULL`;
    const [con] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM contracts WHERE portal_contract_id IS NULL`;
    const [ad] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM ads WHERE portal_placement_id IS NULL`;
    expect(adv.n).toBe(2);
    expect(con.n).toBe(2);
    expect(ad.n).toBe(2);
  });
});
