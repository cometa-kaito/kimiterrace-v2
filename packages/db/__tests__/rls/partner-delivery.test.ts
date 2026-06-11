import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "../../src/client.js";
import {
  type DeliveryInput,
  applyPartnerDelivery,
  findAdvertiserByPortalCompanyId,
} from "../../src/queries/partner-delivery.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）配信受け口の冪等 upsert（`applyPartnerDelivery`）の
 * 実 PG 検証。RLS 二層（system_admin context・BYPASSRLS 不使用）下で `withTenantContext` 経由で実走させ、
 * 冪等性・**【要件1】null contract**・status 反映・upsert 更新を pin する。
 *
 * 接続は DATABASE_URL の superuser（BYPASSRLS）。fixture/検証は raw（BYPASSRLS）、ロジックは
 * `withTenantContext(..., { appRole: 'kimiterrace_app' })` で非 BYPASSRLS ロールへ降ろし system_admin context で走らせる。
 */
describeOrSkip("Partner K3 delivery: applyPartnerDelivery 冪等 upsert (RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  const db = drizzle(sql);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const PORTAL_CO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PORTAL_CONTRACT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const PORTAL_PLACEMENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
    await sql`DELETE FROM ads`;
    await sql`DELETE FROM contracts`;
    await sql`DELETE FROM advertisers`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  /** system_admin context（非 BYPASSRLS の kimiterrace_app へ降格）で applyPartnerDelivery を実行。 */
  function deliver(input: DeliveryInput) {
    return withTenantContext(
      db,
      { userId: null, schoolId: null, role: "system_admin" },
      (tx) => applyPartnerDelivery(tx, input),
      { appRole: "kimiterrace_app" },
    );
  }

  function baseInput(): DeliveryInput {
    return {
      advertiser: {
        portalCompanyId: PORTAL_CO,
        companyName: "テスト広告社",
        industry: "製造",
        contactEmail: "ad@example.com",
        status: "active",
      },
      contract: {
        portalContractId: PORTAL_CONTRACT,
        monthlyFeeJpy: 30000,
        startedAt: new Date("2026-06-01T00:00:00Z"),
        endedAt: null,
        targetV2SchoolIds: [fx.schoolA],
      },
      ads: [
        {
          portalPlacementId: PORTAL_PLACEMENT,
          v2SchoolId: fx.schoolA,
          scope: "school",
          mediaType: "image",
          durationSec: 7,
          displayOrder: 1,
          mediaUrl: "https://storage.googleapis.com/bucket/partner/c.png",
          caption: null,
          linkUrl: "https://advertiser.example.com/",
        },
      ],
    };
  }

  async function counts() {
    const [a] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM advertisers`;
    const [c] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM contracts`;
    const [d] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ads`;
    return { advertisers: a.n, contracts: c.n, ads: d.n };
  }

  it("正常: advertiser/contract/ads を upsert し applied + advertiserId を返す", async () => {
    const res = await deliver(baseInput());
    expect(res.applied).toEqual({ advertisers: 1, contracts: 1, ads: 1 });
    expect(res.advertiserId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await counts()).toEqual({ advertisers: 1, contracts: 1, ads: 1 });

    // ads が advertiser に紐付き、mediaUrl/portal キーが入っている。
    const [ad] = await sql<
      { advertiser_id: string; media_url: string; portal_placement_id: string }[]
    >`SELECT advertiser_id, media_url, portal_placement_id FROM ads`;
    expect(ad.advertiser_id).toBe(res.advertiserId);
    expect(ad.media_url).toBe("https://storage.googleapis.com/bucket/partner/c.png");
    expect(ad.portal_placement_id).toBe(PORTAL_PLACEMENT);

    // 監査（ルール1）: システム作成なので created_by/updated_by は null。
    const [adv] = await sql<
      { created_by: string | null; updated_by: string | null }[]
    >`SELECT created_by, updated_by FROM advertisers`;
    expect(adv.created_by).toBeNull();
    expect(adv.updated_by).toBeNull();
  });

  it("冪等: 同じ portal ID で 2 回送っても二重作成しない（更新のみ）", async () => {
    const first = await deliver(baseInput());

    // 2 回目: companyName / status / mediaUrl を変えて再送。
    const updated = baseInput();
    updated.advertiser.companyName = "テスト広告社（改名）";
    updated.advertiser.status = "paused";
    updated.ads[0].mediaUrl = "https://storage.googleapis.com/bucket/partner/c-v2.png";
    updated.ads[0].displayOrder = 5;
    const second = await deliver(updated);

    // 同一 advertiser id（新規行を作っていない）。
    expect(second.advertiserId).toBe(first.advertiserId);
    expect(await counts()).toEqual({ advertisers: 1, contracts: 1, ads: 1 });

    // 更新が反映されている。
    const [adv] = await sql<
      { company_name: string; status: string; is_active: boolean }[]
    >`SELECT company_name, status, is_active FROM advertisers`;
    expect(adv.company_name).toBe("テスト広告社（改名）");
    expect(adv.status).toBe("paused");
    // status='paused' ⟺ is_active=false（不変条件）。
    expect(adv.is_active).toBe(false);

    const [ad] = await sql<
      { media_url: string; display_order: number }[]
    >`SELECT media_url, display_order FROM ads`;
    expect(ad.media_url).toBe("https://storage.googleapis.com/bucket/partner/c-v2.png");
    expect(ad.display_order).toBe(5);
  });

  it("【要件1】contract が null → contract を作らない（applied.contracts=0）", async () => {
    const input = baseInput();
    input.contract = null;
    const res = await deliver(input);
    expect(res.applied).toEqual({ advertisers: 1, contracts: 0, ads: 1 });
    expect(await counts()).toEqual({ advertisers: 1, contracts: 0, ads: 1 });
  });

  it("【要件1】portalContractId が null → contract を作らない（冪等が壊れないことを再送で確認）", async () => {
    const input = baseInput();
    // biome-ignore lint/style/noNonNullAssertion: baseInput は contract 非 null
    input.contract!.portalContractId = null;

    await deliver(input);
    expect(await counts()).toEqual({ advertisers: 1, contracts: 0, ads: 1 });

    // 再送しても contract は作られない（null を onConflict キーにしていたら毎回新規 = 冪等違反になるはず）。
    await deliver(input);
    expect(await counts()).toEqual({ advertisers: 1, contracts: 0, ads: 1 });
  });

  it("contract 冪等: portalContractId 付きの再送は contract を更新（複数行にしない）", async () => {
    await deliver(baseInput());

    const updated = baseInput();
    // biome-ignore lint/style/noNonNullAssertion: baseInput は contract 非 null
    updated.contract!.monthlyFeeJpy = 99999;
    await deliver(updated);

    expect(await counts()).toEqual({ advertisers: 1, contracts: 1, ads: 1 });
    const [c] = await sql<
      { monthly_fee_jpy: number; portal_contract_id: string }[]
    >`SELECT monthly_fee_jpy, portal_contract_id FROM contracts`;
    expect(c.monthly_fee_jpy).toBe(99999);
    expect(c.portal_contract_id).toBe(PORTAL_CONTRACT);
  });

  it("findAdvertiserByPortalCompanyId で再取得できる（system_admin context）", async () => {
    await deliver(baseInput());
    const found = await withTenantContext(
      db,
      { userId: null, schoolId: null, role: "system_admin" },
      (tx) => findAdvertiserByPortalCompanyId(tx, PORTAL_CO),
      { appRole: "kimiterrace_app" },
    );
    expect(found?.portalCompanyId).toBe(PORTAL_CO);
    expect(found?.companyName).toBe("テスト広告社");
  });

  it("複数 ads を一括 upsert（targetV2SchoolIds が contract.target_schools に入る）", async () => {
    const input = baseInput();
    input.ads.push({
      portalPlacementId: "cccccccc-cccc-4ccc-8ccc-cccccccccc02",
      v2SchoolId: fx.schoolB,
      scope: "school",
      mediaType: "video",
      durationSec: 15,
      displayOrder: 2,
      mediaUrl: "https://storage.googleapis.com/bucket/partner/c2.mp4",
      caption: "字幕",
      linkUrl: null,
    });
    // biome-ignore lint/style/noNonNullAssertion: baseInput は contract 非 null
    input.contract!.targetV2SchoolIds = [fx.schoolA, fx.schoolB];
    const res = await deliver(input);
    expect(res.applied).toEqual({ advertisers: 1, contracts: 1, ads: 2 });

    const [c] = await sql<{ target_schools: string[] }[]>`SELECT target_schools FROM contracts`;
    expect(c.target_schools).toEqual([fx.schoolA, fx.schoolB]);
  });
});
