import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getAdReach } from "../../src/queries/ad-reach.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F07/F09 (#322): 広告到達数 (advertiser reach) 集計を実 PG (RLS 込み) で検証する。
 *
 * ADR-025 の定義 (`(client_id, ad_id, JST 分)` で集計時 DISTINCT) を固定する:
 * (1) 同一分内の重複は 1 到達に集約、(2) 別分は別計上 (分粒度)、(3) 別 client は別計上、
 * (4) client_id 欠落は同一分で 1 に集約 (anti-inflation)、(5) ad 別に group、
 * (6) type=view & adId 有りのみ対象 (tap / adId 無し view は除外)、
 * (7) **テナント越境しない (RLS)**、(8) 空コンテキスト deny、(9) sinceDays 窓。
 */
describeOrSkip("F07/F09 getAdReach (広告到達数 minute-dedup、RLS)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });

  const AD1 = "11111111-1111-4111-8111-111111111111";
  const AD2 = "22222222-2222-4222-8222-222222222222";
  const CLIENT1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CLIENT2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  /**
   * 広告 view を 1 件投入する。occurred_at は `date_trunc('minute', now())` を分アンカーにし
   * 同一 minuteOffset の行は**完全に同一時刻** = 同一 JST 分に落ちる (分境界フレークを排除、[[pg-date-bind-enum-insert]] と
   * 同方針で時刻は全て SQL 側計算)。clientId=null は payload に載せない (NULL 扱い)。
   * adId=null で adId 無し view、type='tap' で tap も投入でき、対象外行の除外を検証できる。
   */
  async function seedView(
    schoolId: string,
    adId: string | null,
    clientId: string | null,
    minuteOffset: number,
    type: "view" | "tap" = "view",
  ): Promise<void> {
    const payload: Record<string, string> = {};
    if (adId !== null) payload.adId = adId;
    if (clientId !== null) payload.clientId = clientId;
    await raw`
      INSERT INTO events (school_id, type, occurred_at, payload)
      VALUES (
        ${schoolId}, ${type},
        date_trunc('minute', now()) - make_interval(days => 1) - make_interval(minutes => ${minuteOffset}::int),
        ${JSON.stringify(payload)}::jsonb
      )
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM events`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("同一 (client, ad, 分) の重複は 1 到達に集約する", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([{ adId: AD1, reach: 1 }]);
  });

  it("別分は別計上する (分粒度で露出量を反映)", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    await seedView(fx.schoolA, AD1, CLIENT1, 5); // 5 分前 → 別分
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([{ adId: AD1, reach: 2 }]);
  });

  it("別 client は同一分でも別計上する", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    await seedView(fx.schoolA, AD1, CLIENT2, 0);
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([{ adId: AD1, reach: 2 }]);
  });

  it("client_id 欠落は同一分で 1 に集約する (anti-inflation, ADR-025)", async () => {
    await seedView(fx.schoolA, AD1, null, 0);
    await seedView(fx.schoolA, AD1, null, 0);
    await seedView(fx.schoolA, AD1, null, 0);
    // 別分の欠落は別計上される (分粒度は維持)
    await seedView(fx.schoolA, AD1, null, 7);
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([{ adId: AD1, reach: 2 }]);
  });

  it("ad 別に group し、到達数降順 → adId 昇順で返す", async () => {
    // AD1: client1/client2 同一分 → reach 2、AD2: client1 のみ → reach 1
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    await seedView(fx.schoolA, AD1, CLIENT2, 0);
    await seedView(fx.schoolA, AD2, CLIENT1, 0);
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([
      { adId: AD1, reach: 2 },
      { adId: AD2, reach: 1 },
    ]);
  });

  it("type=tap と adId 無し view は到達数に含めない", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0); // 対象
    await seedView(fx.schoolA, AD1, CLIENT1, 0, "tap"); // tap → 除外
    await seedView(fx.schoolA, null, CLIENT1, 0); // adId 無し view → 除外
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([{ adId: AD1, reach: 1 }]);
  });

  it("期間窓: sinceDays より古い view は含めない (DB now() 基準)", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0); // 1 日前 (範囲内)
    // 40 日前 (既定 30 日窓外): minuteOffset では日跨ぎしないため日指定で別途投入
    await raw`
      INSERT INTO events (school_id, type, occurred_at, payload)
      VALUES (${fx.schoolA}, 'view', now() - make_interval(days => 40), ${JSON.stringify({ adId: AD1, clientId: CLIENT2 })}::jsonb)
    `;
    const reach = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([{ adId: AD1, reach: 1 }]);

    const wide = await withTenantContext(
      db,
      ctxA(),
      (tx) => getAdReach(tx, { sinceDays: 90 }),
      APP,
    );
    expect(wide).toEqual([{ adId: AD1, reach: 2 }]);
  });

  it("テナント分離: A コンテキストからは B 校の広告 view が漏れない (RLS)", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    await seedView(fx.schoolB, AD1, CLIENT1, 0);
    await seedView(fx.schoolB, AD2, CLIENT2, 0);

    const a = await withTenantContext(db, ctxA(), (tx) => getAdReach(tx), APP);
    expect(a).toEqual([{ adId: AD1, reach: 1 }]);

    const b = await withTenantContext(db, ctxB(), (tx) => getAdReach(tx), APP);
    expect(b).toEqual([
      { adId: AD1, reach: 1 },
      { adId: AD2, reach: 1 },
    ]);
  });

  it("空コンテキストは deny-by-default で空配列", async () => {
    await seedView(fx.schoolA, AD1, CLIENT1, 0);
    const reach = await withTenantContext(db, {}, (tx) => getAdReach(tx), APP);
    expect(reach).toEqual([]);
  });
});
