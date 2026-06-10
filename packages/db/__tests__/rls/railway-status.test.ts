import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getRailwayStatus, upsertRailwayStatus } from "../../src/queries/railway-status.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * パターン2「鉄道」 railway_status の RLS（公開参照マスタ特例：read_all + write_system）を実 PG で検証する。
 * weather_forecasts（0017）と同型。匿名サイネージが読め、system_admin（取得 Job）だけが書ける。
 */
describeOrSkip("RLS: railway_status（鉄道運行情報・公開キャッシュ）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  const ctxSys = () => ({ role: "system_admin" as const });
  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  // 匿名サイネージ: role 未設定・school_id のみ（ADR-016 の deny-by-default 接続）。
  const ctxAnon = () => ({ schoolId: fx.schoolA });

  function upsert(statusText: string, hasDisruption: boolean) {
    return {
      operator: "meitetsu",
      operatorName: "名鉄",
      hasDisruption,
      statusText,
      sourceUrl: "https://top.meitetsu.co.jp/em/",
    };
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM railway_status`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("system は upsert でき、匿名サイネージ / school_admin とも read できる（read_all）", async () => {
    await withTenantContext(
      db,
      ctxSys(),
      (tx) => upsertRailwayStatus(tx, upsert("15分以上の列車の遅れはございません。", false)),
      APP,
    );
    const anon = await withTenantContext(
      db,
      ctxAnon(),
      (tx) => getRailwayStatus(tx, "meitetsu"),
      APP,
    );
    expect(anon?.statusText).toBe("15分以上の列車の遅れはございません。");
    expect(anon?.operatorName).toBe("名鉄");

    const a = await withTenantContext(db, ctxA(), (tx) => getRailwayStatus(tx, "meitetsu"), APP);
    expect(a?.operator).toBe("meitetsu");
  });

  it("upsert は同一 operator を 1 行で更新する（ON CONFLICT operator）", async () => {
    await withTenantContext(
      db,
      ctxSys(),
      (tx) => upsertRailwayStatus(tx, upsert("平常運転", false)),
      APP,
    );
    await withTenantContext(
      db,
      ctxSys(),
      (tx) => upsertRailwayStatus(tx, upsert("名古屋本線で遅延が発生しています。", true)),
      APP,
    );
    const r = await withTenantContext(db, ctxAnon(), (tx) => getRailwayStatus(tx, "meitetsu"), APP);
    expect(r?.statusText).toBe("名古屋本線で遅延が発生しています。");
    expect(r?.hasDisruption).toBe(true);
    const [{ count }] = await raw<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM railway_status`;
    expect(count).toBe(1);
  });

  it("非 system（school_admin）コンテキストは書き込めない（write_system）", async () => {
    await expect(
      withTenantContext(
        db,
        ctxA(),
        (tx) => upsertRailwayStatus(tx, upsert("不正書込", false)),
        APP,
      ),
    ).rejects.toThrow();
  });

  it("該当 operator が無ければ null（fail-soft）", async () => {
    const r = await withTenantContext(db, ctxAnon(), (tx) => getRailwayStatus(tx, "meitetsu"), APP);
    expect(r).toBeNull();
  });
});
