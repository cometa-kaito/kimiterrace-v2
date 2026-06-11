import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getAdvertiserMetrics } from "../../src/queries/advertiser-metrics.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * Partner API K1 (partner-api-contract §2): 単一広告主×指定月の効果メトリクス `getAdvertiserMetrics` を
 * 実 PG (RLS 込み) で検証する。`advertiser-report.test.ts` の seed 流儀を踏襲しつつ K1 固有の追加検証:
 *  (1) 単一広告主に絞った impressions/taps/asks (反応の連鎖を 1 社へ filter)、
 *  (2) **presence (接触機会)**: 対象校 = `ads.advertiser_id = {id}` の distinct school_id の当月 presence を
 *      distinct(device_mac) で数える。別広告主の対象校の presence は数えない・同一 device_mac の再送は 1、
 *  (3) contracts 一覧 (status / target_school_count / monthly_fee_jpy)、
 *  (4) by=school 内訳 (impressions/taps/presence を school 別)、
 *  (5) 不存在 advertiser は null (→ route が 404)、
 *  (6) 非 system_admin context では CRM 表が不可視で null (deny-by-default)、
 *  (7) 月範囲外は RangeError。
 *
 * fixture は 2 校 (schoolA/schoolB) + system_admin。時刻は make_timestamptz で DB 側に絶対 JST 時刻を組む。
 */
describeOrSkip(
  "Partner K1 getAdvertiserMetrics (単一広告主 月次 + presence、RLS system_admin)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const { sql: raw, db } = createDbClient(url!);
    const APP = { appRole: "kimiterrace_app" };
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

    const Y = 2026;
    const M = 3;
    const sysCtx = () => ({ userId: fx.sysAdmin, role: "system_admin" as const });

    async function seedAdvertiser(companyName: string): Promise<string> {
      const [row] = await raw<{ id: string }[]>`
      INSERT INTO advertisers (company_name, status, is_active)
      VALUES (${companyName}, 'active', true) RETURNING id`;
      return row.id;
    }

    const jstTs = (t: { y: number; mo: number; d: number }) =>
      raw`make_timestamptz(${t.y}::int, ${t.mo}::int, ${t.d}::int, 0, 0, 0, 'Asia/Tokyo')`;

    async function seedContract(
      advertiserId: string,
      opts: { targetSchools?: string[]; monthlyFeeJpy?: number } = {},
    ): Promise<string> {
      const targets = JSON.stringify(opts.targetSchools ?? []);
      const fee = opts.monthlyFeeJpy ?? 30000;
      const [row] = await raw<{ id: string }[]>`
      INSERT INTO contracts (advertiser_id, status, started_at, ended_at, monthly_fee_jpy, target_schools)
      VALUES (${advertiserId}, 'active', ${jstTs({ y: Y, mo: 1, d: 1 })}, NULL, ${fee}, ${targets}::jsonb)
      RETURNING id`;
      return row.id;
    }

    async function seedContent(schoolId: string, title: string): Promise<string> {
      const [row] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, publish_scope, status)
      VALUES (${schoolId}, ${title}, 'school', 'published') RETURNING id`;
      return row.id;
    }

    async function linkContractContent(contractId: string, contentId: string): Promise<void> {
      await raw`INSERT INTO contract_contents (contract_id, content_id) VALUES (${contractId}, ${contentId})`;
    }

    /** ads 行を 1 件作る (presence の対象校解決 = ads.advertiser_id → school_id 用)。 */
    async function seedAd(schoolId: string, advertiserId: string): Promise<void> {
      await raw`
      INSERT INTO ads (school_id, scope, advertiser_id, media_url, media_type, duration_sec)
      VALUES (${schoolId}, 'school', ${advertiserId}, 'gs://x', 'image', 5)`;
    }

    async function seedReaction(
      schoolId: string,
      contentId: string,
      type: "view" | "tap" | "ask",
      ts: { d: number; h: number },
    ): Promise<void> {
      await raw`
      INSERT INTO events (school_id, content_id, type, occurred_at, payload)
      VALUES (${schoolId}, ${contentId}, ${type},
        make_timestamptz(${Y}::int, ${M}::int, ${ts.d}::int, ${ts.h}::int, 0, 0, 'Asia/Tokyo'), '{}'::jsonb)`;
    }

    /** presence event を 1 件 (device_mac は dedup 識別子)。occurred_at が毎回異なるよう h/mi で散らす。 */
    async function seedPresence(
      schoolId: string,
      deviceMac: string,
      ts: { d: number; h: number; mi: number },
    ): Promise<void> {
      await raw`
      INSERT INTO events (school_id, content_id, type, occurred_at, payload)
      VALUES (${schoolId}, NULL, 'presence',
        make_timestamptz(${Y}::int, ${M}::int, ${ts.d}::int, ${ts.h}::int, ${ts.mi}::int, 0, 'Asia/Tokyo'),
        ${JSON.stringify({ device_mac: deviceMac })}::jsonb)`;
    }

    beforeAll(async () => {
      fx = await seedBaseFixture(raw);
    });

    beforeEach(async () => {
      await raw`RESET ROLE`;
      await raw`DELETE FROM events`;
      await raw`DELETE FROM contract_contents`;
      await raw`DELETE FROM contracts`;
      await raw`DELETE FROM ads`;
      await raw`DELETE FROM advertisers`;
      await raw`DELETE FROM contents`;
    });

    afterAll(async () => {
      await raw.end({ timeout: 5 });
    });

    const run = (advertiserId: string, bySchool = false) =>
      withTenantContext(
        db,
        sysCtx(),
        (tx) => getAdvertiserMetrics(tx, { advertiserId, year: Y, month: M, bySchool }),
        APP,
      );

    it("単一広告主の impressions/taps/asks を反応の連鎖から数える", async () => {
      const adv = await seedAdvertiser("アクメ社");
      const con = await seedContract(adv);
      const content = await seedContent(fx.schoolA, "アクメ掲示");
      await linkContractContent(con, content);
      await seedReaction(fx.schoolA, content, "view", { d: 5, h: 10 });
      await seedReaction(fx.schoolA, content, "view", { d: 5, h: 11 });
      await seedReaction(fx.schoolA, content, "tap", { d: 6, h: 9 });
      await seedReaction(fx.schoolA, content, "ask", { d: 7, h: 9 });

      const m = await run(adv);
      expect(m).not.toBeNull();
      expect(m?.totals).toMatchObject({ impressions: 2, taps: 1, asks: 1, dwellSeconds: 0 });
      expect(m?.companyName).toBe("アクメ社");
    });

    it("presence: 対象校 (ads.advertiser_id) の当月 presence を distinct(device_mac) で数える", async () => {
      const adv = await seedAdvertiser("リーチ社");
      // 対象校 = A 校 (ads でこの広告主の広告が A 校に出ている)。
      await seedAd(fx.schoolA, adv);
      // A 校: 2 台 (mac1, mac2)。mac1 は再送 (別時刻) でも 1 台にまとまる。
      await seedPresence(fx.schoolA, "DC:AA:11", { d: 3, h: 8, mi: 0 });
      await seedPresence(fx.schoolA, "dcaa11", { d: 3, h: 8, mi: 5 }); // 表記ゆれ + 別時刻 → 同一端末
      await seedPresence(fx.schoolA, "DC:AA:22", { d: 4, h: 9, mi: 0 });
      // B 校の presence は対象校でない (この広告主の ads が B 校に無い) → 数えない。
      await seedPresence(fx.schoolB, "DC:BB:99", { d: 3, h: 8, mi: 0 });

      const m = await run(adv);
      // distinct device_mac = {mac1, mac2} = 2 (B 校は対象外)。
      expect(m?.totals.presence).toBe(2);
    });

    it("contracts 一覧: status / target_school_count / monthly_fee_jpy を返す", async () => {
      const adv = await seedAdvertiser("契約社");
      await seedContract(adv, { targetSchools: [fx.schoolA, fx.schoolB], monthlyFeeJpy: 50000 });

      const m = await run(adv);
      expect(m?.contracts).toEqual([
        expect.objectContaining({ status: "active", targetSchoolCount: 2, monthlyFeeJpy: 50000 }),
      ]);
    });

    it("by=school: impressions/taps/presence を school 別に返す", async () => {
      const adv = await seedAdvertiser("内訳社");
      const con = await seedContract(adv);
      const contentA = await seedContent(fx.schoolA, "A 掲示");
      const contentB = await seedContent(fx.schoolB, "B 掲示");
      await linkContractContent(con, contentA);
      await linkContractContent(con, contentB);
      await seedReaction(fx.schoolA, contentA, "view", { d: 5, h: 10 });
      await seedReaction(fx.schoolA, contentA, "view", { d: 5, h: 11 });
      await seedReaction(fx.schoolB, contentB, "view", { d: 5, h: 10 });
      // 両校に ads (対象校) + presence。
      await seedAd(fx.schoolA, adv);
      await seedAd(fx.schoolB, adv);
      await seedPresence(fx.schoolA, "AA:01", { d: 3, h: 8, mi: 0 });
      await seedPresence(fx.schoolA, "AA:02", { d: 3, h: 9, mi: 0 });
      await seedPresence(fx.schoolB, "BB:01", { d: 3, h: 8, mi: 0 });

      const m = await run(adv, true);
      expect(m?.bySchool).toBeDefined();
      const bySchool = m?.bySchool ?? [];
      // impressions 降順 → A 校 (2) が先。
      expect(bySchool[0]).toMatchObject({ schoolId: fx.schoolA, impressions: 2, presence: 2 });
      const b = bySchool.find((s) => s.schoolId === fx.schoolB);
      expect(b).toMatchObject({ impressions: 1, presence: 1 });
    });

    it("存在しない advertiser は null (→ route が 404)", async () => {
      const m = await run("00000000-0000-4000-8000-000000000000");
      expect(m).toBeNull();
    });

    it("非 system_admin context では CRM 表が不可視で null (deny-by-default)", async () => {
      const adv = await seedAdvertiser("見えない社");
      await seedContract(adv);
      const asTeacher = await withTenantContext(
        db,
        { userId: fx.userA, schoolId: fx.schoolA, role: "teacher" },
        (tx) => getAdvertiserMetrics(tx, { advertiserId: adv, year: Y, month: M }),
        APP,
      );
      expect(asTeacher).toBeNull();
    });

    it("月範囲外 (0 / 13) は RangeError", async () => {
      const adv = await seedAdvertiser("範囲外社");
      await expect(
        withTenantContext(
          db,
          sysCtx(),
          (tx) => getAdvertiserMetrics(tx, { advertiserId: adv, year: Y, month: 0 }),
          APP,
        ),
      ).rejects.toThrow(RangeError);
    });
  },
);
