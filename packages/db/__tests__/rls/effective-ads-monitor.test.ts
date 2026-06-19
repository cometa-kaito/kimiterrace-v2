import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getEffectiveAdsForMonitor } from "../../src/queries/effective-ads.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * Phase5 v2-PR2: `getEffectiveAdsForMonitor`（モニタ単位の実効広告読取）を実 PG で検証する。
 *
 * 「追加モード」の合成を pin する:
 *   - クラス継承（`effective_ads_per_class` view 由来）∪ モニタ直指定（`ad_target_monitors` 由来）。
 *   - モニタ直指定は scope_rank=4（class=3 の後＝最も具体的）・is_inherited=false・source_scope='monitor'。
 *   - クラス無し端末（廊下等・classId=null）はモニタ直指定のみ。
 *   - 休止広告主（advertisers.status=paused）のモニタ直指定広告は配信から除外（BUG-1 と整合）。
 *   - RLS（ルール2）: 自校コンテキストでは他校端末の monitorId / 他校の classId は 0 件（越境配信を構造的に防ぐ）。
 *
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。read は appRole で kimiterrace_app へ
 * 降格させ RLS を実効化する（system_admin バイパスに頼らない）。
 */
describeOrSkip(
  "query: getEffectiveAdsForMonitor（モニタ実効広告 = クラス継承 ∪ モニタ直指定）",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const { sql: raw, db } = createDbClient(url!);
    const APP = { appRole: "kimiterrace_app" } as const;
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

    // School A 階層 + 端末
    let classA: string;
    let monA: string; // school A の端末（クラス継承 + 直指定）
    let monAEmpty: string; // school A の端末（直指定なし = クラス継承のみ / 空）
    // School B（テナント分離検証用）
    let classB: string;
    let monB: string;

    // 期待する media_url（順序・包含の判定に使う）
    const SCHOOL_AD = "https://ex.com/a-school.png";
    const CLASS_AD = "https://ex.com/a-class.png";
    const MONITOR_AD = "https://ex.com/a-monitor.png";
    const MONITOR_AD_PAUSED = "https://ex.com/a-monitor-paused.png";
    const MONITOR_AD_B = "https://ex.com/b-monitor.png";

    const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
    const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });

    async function seedMonitor(schoolId: string, deviceId: string, classId: string | null) {
      const [r] = await raw<{ id: string }[]>`
      INSERT INTO tv_devices (device_id, school_id, class_id)
      VALUES (${deviceId}, ${schoolId}, ${classId}) RETURNING id`;
      return r.id;
    }
    async function seedMonitorAd(
      schoolId: string,
      mediaUrl: string,
      monitorId: string,
      advertiserId: string | null,
    ) {
      const [a] = await raw<{ id: string }[]>`
      INSERT INTO ads (school_id, scope, advertiser_id, media_url, media_type, display_order)
      VALUES (${schoolId}, 'monitor', ${advertiserId}, ${mediaUrl}, 'image', 0) RETURNING id`;
      await raw`INSERT INTO ad_target_monitors (ad_id, monitor_id, school_id)
      VALUES (${a.id}, ${monitorId}, ${schoolId})`;
      return a.id;
    }

    beforeAll(async () => {
      fx = await seedBaseFixture(raw);

      // --- School A: 学年 → クラス（クラス継承の素） ---
      const gradeA = (
        await raw<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolA}, '1年', 1) RETURNING id`
      )[0].id;
      classA = (
        await raw<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolA}, ${gradeA}, '1-A', 1) RETURNING id`
      )[0].id;
      // 学校スコープ広告（classA に継承）+ クラススコープ広告（classA 自身）。広告主なし = 常に配信対象。
      await raw`INSERT INTO ads (school_id, scope, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'school', ${SCHOOL_AD}, 'image', 10)`;
      await raw`INSERT INTO ads (school_id, scope, class_id, media_url, media_type, display_order)
      VALUES (${fx.schoolA}, 'class', ${classA}, ${CLASS_AD}, 'image', 20)`;

      // --- School A: 端末 ---
      monA = await seedMonitor(fx.schoolA, "mon-a-1", classA);
      monAEmpty = await seedMonitor(fx.schoolA, "mon-a-empty", classA);
      // monA へのモニタ直指定（広告主なし = 配信される）
      await seedMonitorAd(fx.schoolA, MONITOR_AD, monA, null);
      // 休止広告主のモニタ直指定（除外されるべき）
      const advPaused = (
        await raw<{ id: string }[]>`
        INSERT INTO advertisers (company_name, status, is_active)
        VALUES ('休止広告主', 'paused', false) RETURNING id`
      )[0].id;
      await seedMonitorAd(fx.schoolA, MONITOR_AD_PAUSED, monA, advPaused);

      // --- School B: テナント分離検証用 ---
      const gradeB = (
        await raw<{ id: string }[]>`
        INSERT INTO grades (school_id, name, display_order)
        VALUES (${fx.schoolB}, '1年', 1) RETURNING id`
      )[0].id;
      classB = (
        await raw<{ id: string }[]>`
        INSERT INTO classes (school_id, grade_id, name, grade)
        VALUES (${fx.schoolB}, ${gradeB}, '1-B', 1) RETURNING id`
      )[0].id;
      monB = await seedMonitor(fx.schoolB, "mon-b-1", classB);
      await seedMonitorAd(fx.schoolB, MONITOR_AD_B, monB, null);
    });

    afterAll(async () => {
      await raw.end({ timeout: 5 });
    });

    it("追加モード: クラス継承（学校+クラス）∪ モニタ直指定 を scope_rank 順で返す", async () => {
      const rows = await withTenantContext(
        db,
        ctxA(),
        (tx) => getEffectiveAdsForMonitor(tx, classA, monA),
        APP,
      );
      // school(rank0) → class(rank3) → monitor(rank4) の順。休止広告主の直指定は除外。
      expect(rows.map((r) => r.mediaUrl)).toEqual([SCHOOL_AD, CLASS_AD, MONITOR_AD]);
      expect(rows.map((r) => r.scopeRank)).toEqual([0, 3, 4]);
      expect(rows.map((r) => r.sourceScope)).toEqual(["school", "class", "monitor"]);
      expect(rows.map((r) => r.isInherited)).toEqual([true, false, false]);
      // 休止広告主のモニタ直指定は配信されない（BUG-1 整合）
      expect(rows.map((r) => r.mediaUrl)).not.toContain(MONITOR_AD_PAUSED);
    });

    it("クラス無し端末（classId=null）はモニタ直指定のみ（クラス継承は空集合）", async () => {
      const rows = await withTenantContext(
        db,
        ctxA(),
        (tx) => getEffectiveAdsForMonitor(tx, null, monA),
        APP,
      );
      expect(rows.map((r) => r.mediaUrl)).toEqual([MONITOR_AD]);
      expect(rows[0].sourceScope).toBe("monitor");
      expect(rows[0].scopeRank).toBe(4);
    });

    it("直指定なし端末はクラス継承のみ（モニタ直指定は空）", async () => {
      const rows = await withTenantContext(
        db,
        ctxA(),
        (tx) => getEffectiveAdsForMonitor(tx, classA, monAEmpty),
        APP,
      );
      expect(rows.map((r) => r.mediaUrl)).toEqual([SCHOOL_AD, CLASS_AD]);
      expect(rows.every((r) => r.sourceScope !== "monitor")).toBe(true);
    });

    it("RLS: 自校コンテキストで他校端末の monitorId を渡してもモニタ直指定は 0 件（越境防止）", async () => {
      const rows = await withTenantContext(
        db,
        ctxA(), // school A コンテキスト
        (tx) => getEffectiveAdsForMonitor(tx, null, monB), // school B の端末
        APP,
      );
      expect(rows).toHaveLength(0);
    });

    it("RLS: 自校コンテキストで他校 classId を渡してもクラス継承は 0 件（越境防止）", async () => {
      const rows = await withTenantContext(
        db,
        ctxA(), // school A コンテキスト
        (tx) => getEffectiveAdsForMonitor(tx, classB, monAEmpty), // school B のクラス
        APP,
      );
      // 他校クラスは view から不可視・自端末に直指定なし → 完全に空
      expect(rows).toHaveLength(0);
    });

    it("RLS: school B コンテキストでは自校の合成のみ（A は混ざらない）", async () => {
      const rows = await withTenantContext(
        db,
        ctxB(),
        (tx) => getEffectiveAdsForMonitor(tx, classB, monB),
        APP,
      );
      expect(rows.map((r) => r.mediaUrl)).toEqual([MONITOR_AD_B]);
      expect(rows.every((r) => r.schoolId === fx.schoolB)).toBe(true);
    });
  },
);
