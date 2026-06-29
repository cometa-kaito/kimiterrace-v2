import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { runTvLivenessCheck } from "../../src/queries/tv-liveness-checker.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F16 (ADR-023): TV ダウンタイム記録 tv_device_downtime の RLS テナント分離 + 死活チェッカ
 * （runTvLivenessCheck）の down/recover 遷移・ダウンタイム記録・冪等性を実 PG で検証する。
 *
 * - tenant_isolation: 自校のみ可視、他テナント INSERT は WITH CHECK で拒否、context 未設定で 0 件
 * - system_admin_full_access: cross-tenant で全件可視
 * - runTvLivenessCheck: 閾値超で down 行作成 + alert_state='down' / 復帰で recovered_at + duration_sec
 *   記録 + alert_state='ok' / 再走査で二重計上しない（冪等）
 *
 * すべて実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。RLS 検証・runTvLivenessCheck は
 * テスト superuser 接続を `appRole: 'kimiterrace_app'` で降格させ RLS を実際に効かせる（さもないと vacuous）。
 * `sql`（BYPASSRLS スーパーユーザー）はシード/検証専用、`db`（同接続を appRole で降格）はドメイン関数用。
 *
 * 時刻は JS Date を bind せず DB 側 `now() - make_interval(...)` で算出する
 * （[[pg-date-bind-enum-insert]] / [[pg-timestamptz-read-string]]）。
 */
describeOrSkip("RLS: F16 tv_device_downtime", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  const DEV_A = "11111111-1111-4111-8111-111111111111";
  const DEV_B = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に TV 1 台ずつ（BYPASSRLS = テーブル所有者接続でシード）。downtime の FK 先 (device_id) を用意。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, label, version)
      VALUES (${fx.schoolA}, ${DEV_A}, '電子工学科 1年', 1)
    `;
    await sql`
      INSERT INTO tv_devices (school_id, device_id, label, version)
      VALUES (${fx.schoolB}, ${DEV_B}, '職員室', 1)
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
    // 各テストを独立させる: downtime 行を全消去し、TV を ok / 鮮度 OK に戻す。
    // 死活チェッカは cross-tenant (system_admin) で全デバイスを走査するため、**監視対象を DEV_A のみに
    // 限定**する (他は monitoring_enabled=false)。これで他校 (DEV_B) や共有 DB 上の他テスト由来デバイスが
    // チェッカの新規 down 計上に混入せず、newlyDown / downtime 行数のアサートが device セットに依存しない。
    await sql`DELETE FROM tv_device_downtime`;
    // long_silence_notified_at も毎回 NULL に戻す（長時間サイレンスの dedup 列。前テストの立ち上げを持ち越さない）。
    await sql`UPDATE tv_devices SET alert_state = 'ok', monitoring_enabled = (device_id = ${DEV_A}), last_seen_at = now(), last_boot_at = NULL, long_silence_notified_at = NULL`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  // 任意の downtime 行を BYPASSRLS でシードするヘルパ（時刻は DB 側算出）。
  async function seedDowntime(
    schoolId: string,
    deviceId: string,
    wentDownMinutesAgo: number,
  ): Promise<void> {
    await sql`
      INSERT INTO tv_device_downtime (school_id, device_id, went_down_at)
      VALUES (${schoolId}, ${deviceId}, now() - make_interval(mins => ${wentDownMinutesAgo}::int))
    `;
  }

  // ---- RLS テナント分離 ----

  it("school A context は A のダウンタイム行のみ可視", async () => {
    await seedDowntime(fx.schoolA, DEV_A, 10);
    await seedDowntime(fx.schoolB, DEV_B, 10);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ device_id: string; school_id: string }[]>`
        SELECT device_id, school_id FROM tv_device_downtime
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].device_id).toBe(DEV_A);
    });
  });

  it("context 未設定 → 全件拒否（0 件、deny by default）", async () => {
    await seedDowntime(fx.schoolA, DEV_A, 10);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM tv_device_downtime`;
      expect(rows.length).toBe(0);
    });
  });

  it("他テナント school_id で INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO tv_device_downtime (school_id, device_id, went_down_at)
          VALUES (${fx.schoolB}, ${DEV_B}, now())
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("system_admin は cross-tenant で全ダウンタイム行が見える", async () => {
    await seedDowntime(fx.schoolA, DEV_A, 10);
    await seedDowntime(fx.schoolB, DEV_B, 10);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM tv_device_downtime`;
      expect(rows.length).toBe(2);
    });
  });

  // ---- 死活チェッカ（runTvLivenessCheck）: down/recover/冪等 ----

  it("runTvLivenessCheck: 閾値超で down 行作成 + alert_state='down'（appRole 降格で RLS 実効）", async () => {
    // A の TV を 10 分前から無応答にする（通常閾値 3 分超）。updated_at の前進を検証するため十分過去に置く。
    await sql`UPDATE tv_devices SET last_seen_at = now() - make_interval(mins => 10), updated_at = now() - make_interval(mins => 10) WHERE device_id = ${DEV_A}`;
    const before = await sql<{ updated_at: string }[]>`
      SELECT updated_at FROM tv_devices WHERE device_id = ${DEV_A}
    `;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.newlyDown).toBe(1);
    expect(summary.recovered).toBe(0);

    // 副作用検証（BYPASSRLS 接続で）: downtime 行 1 件（未解決） + alert_state='down'。
    const rows = await sql<{ device_id: string; recovered_at: string | null; school_id: string }[]>`
      SELECT device_id, recovered_at, school_id FROM tv_device_downtime
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].device_id).toBe(DEV_A);
    expect(rows[0].recovered_at).toBeNull();
    expect(rows[0].school_id).toBe(fx.schoolA);

    const tv = await sql<{ alert_state: string; updated_at: string }[]>`
      SELECT alert_state, updated_at FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(tv[0].alert_state).toBe("down");
    // ルール1 / Medium-1: alert_state 反転時に updated_at が前進していること（監査整合性、[[updatedat-explicit-on-update]]）。
    expect(new Date(tv[0].updated_at).getTime()).toBeGreaterThan(
      new Date(before[0].updated_at).getTime(),
    );
  });

  it("runTvLivenessCheck: down エッジが端末の fcm_token を downDevices に載せる（遠隔起動の宛先）", async () => {
    // A の TV に FCM トークンを保存し、10 分前から無応答にする（新規 down）。
    await sql`UPDATE tv_devices SET fcm_token = 'tok-wake-aaa', last_seen_at = now() - make_interval(mins => 10) WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.newlyDown).toBe(1);
    expect(summary.downDevices).toHaveLength(1);
    // entrypoint（apps/jobs）が wake 送信先に使う fcm_token がエッジに載っている。
    expect(summary.downDevices[0]?.deviceId).toBe(DEV_A);
    expect(summary.downDevices[0]?.fcmToken).toBe("tok-wake-aaa");
  });

  it("runTvLivenessCheck: fcm_token 未報告（NULL）の down は downDevices.fcmToken=null（送信対象外）", async () => {
    // fcm_token を明示的に NULL（旧 APK / 報告前）にして無応答にする。
    await sql`UPDATE tv_devices SET fcm_token = NULL, last_seen_at = now() - make_interval(mins => 10) WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.newlyDown).toBe(1);
    expect(summary.downDevices[0]?.fcmToken).toBeNull();
  });

  it("runTvLivenessCheck: 再走査で二重計上しない（idempotent / send-once）", async () => {
    await sql`UPDATE tv_devices SET last_seen_at = now() - make_interval(mins => 10) WHERE device_id = ${DEV_A}`;

    const first = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(first.newlyDown).toBe(1);

    // 同じ無応答状態のまま再実行 → 既に未解決行があるので down→down は no-op。
    const second = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(second.newlyDown).toBe(0);

    const count = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM tv_device_downtime`;
    expect(count[0].n).toBe("1");
  });

  it("runTvLivenessCheck: 復帰で recovered_at + duration_sec 記録 + alert_state='ok'", async () => {
    // 既に down 計上中（5 分前にダウン、alert_state='down'）の状態を作る。
    await seedDowntime(fx.schoolA, DEV_A, 5);
    await sql`UPDATE tv_devices SET alert_state = 'down', last_seen_at = now() WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.recovered).toBe(1);
    expect(summary.newlyDown).toBe(0);

    const rows = await sql<{ recovered_at: string | null; duration_sec: number | null }[]>`
      SELECT recovered_at, duration_sec FROM tv_device_downtime WHERE device_id = ${DEV_A}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].recovered_at).not.toBeNull();
    // 5 分前にダウン → duration はおよそ 300 秒（実行誤差を見て 270〜360 で許容）。
    expect(rows[0].duration_sec).not.toBeNull();
    expect(rows[0].duration_sec as number).toBeGreaterThanOrEqual(270);
    expect(rows[0].duration_sec as number).toBeLessThanOrEqual(360);

    const tv = await sql<{ alert_state: string }[]>`
      SELECT alert_state FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(tv[0].alert_state).toBe("ok");
  });

  it("runTvLivenessCheck: 未解決行を持つ TV が他にいても、自分に未解決行が無い鮮度OKの TV は recover しない（hasOpenDowntime 相関）", async () => {
    // 回帰: hasOpenDowntime の EXISTS サブクエリが相関し損ねると、ある TV が未解決行を持つだけで
    // 「未解決行が存在すれば true」になり、未解決行を持たない別の鮮度OK・ok の TV まで recover 計上
    // されてしまう（loadDeviceStates の相関外れバグ）。device 単位で相関していることを実 PG で固定する。
    //
    // 構成: DEV_B のみ未解決ダウンタイム + alert_state='down'（=本物の復帰対象）。DEV_A は鮮度OK・ok・
    // 未解決行なし（recover してはならない）。monitoring_enabled は beforeEach で DEV_A のみ true だが、
    // recover は monitoring を無視するため DEV_B も復帰判定対象になる点に注意（ここは仕様どおり）。
    await seedDowntime(fx.schoolB, DEV_B, 5);
    await sql`UPDATE tv_devices SET alert_state = 'down', last_seen_at = now() WHERE device_id = ${DEV_B}`;
    // DEV_A は明示的に「鮮度OK・ok・未解決行なし」を担保（beforeEach 後の状態を固定）。
    await sql`UPDATE tv_devices SET alert_state = 'ok', last_seen_at = now() WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    // 復帰したのはちょうど 1 台（DEV_B）だけ。相関が外れると DEV_A も数えられ 2 になる。
    expect(summary.recovered).toBe(1);
    expect(summary.newlyDown).toBe(0);

    // 締められた未解決行は DEV_B の 1 行のみ。DEV_A にはそもそもダウンタイム行が無い。
    const recoveredDevices = await sql<{ device_id: string }[]>`
      SELECT device_id FROM tv_device_downtime WHERE recovered_at IS NOT NULL ORDER BY device_id
    `;
    expect(recoveredDevices.map((r) => r.device_id)).toEqual([DEV_B]);
    const devARows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM tv_device_downtime WHERE device_id = ${DEV_A}
    `;
    expect(devARows[0].n).toBe("0");

    // DEV_A は ok のまま（誤って遷移させられていない）、DEV_B は復帰で ok。
    const states = await sql<{ device_id: string; alert_state: string }[]>`
      SELECT device_id, alert_state FROM tv_devices WHERE device_id IN (${DEV_A}, ${DEV_B}) ORDER BY device_id
    `;
    expect(states.find((s) => s.device_id === DEV_A)?.alert_state).toBe("ok");
    expect(states.find((s) => s.device_id === DEV_B)?.alert_state).toBe("ok");
  });

  it("runTvLivenessCheck: monitoring_enabled=false の無応答 TV は down 計上しない", async () => {
    await sql`UPDATE tv_devices SET last_seen_at = now() - make_interval(mins => 10), monitoring_enabled = false WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.newlyDown).toBe(0);
    const count = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM tv_device_downtime`;
    expect(count[0].n).toBe("0");
  });

  it("runTvLivenessCheck: 初回 down を 2 接続で同時実行しても未解決行はちょうど 1 行（phantom INSERT 根治、Medium-2）", async () => {
    // 初回 down（未解決行がまだ 0 件）を作る: A の TV を 10 分前から無応答（通常閾値 3 分超）、alert_state='ok'。
    // この段階では tv_device_downtime に行が無いため、down INSERT 前の「未解決行 FOR UPDATE 再確認」は
    // 空集合になり、未解決行側だけのロックでは 2 本目の phantom INSERT を止められない。根治は親 tv_devices
    // 行を FOR UPDATE でロックして device 単位の直列化点を作ること（[[realpg_concurrency_test_deterministic]]）。
    await sql`UPDATE tv_devices SET alert_state = 'ok', last_seen_at = now() - make_interval(mins => 10) WHERE device_id = ${DEV_A}`;

    // postgres-js の pool（max:10）から 2 接続を引き、Promise.all で真に同時発火する。両 tx は同じ親行
    // (DEV_A) を FOR UPDATE しにいくため必ず競合し、ロック獲得順に直列化される。2 本目は 1 本目の commit 後に
    // 未解決行を再走査して INSERT を見送るため、どちらが勝っても「未解決行 = 1」は不変（timing 非依存）。
    const run = () =>
      withTenantContext(
        db,
        { role: "system_admin" },
        (tx) => runTvLivenessCheck(tx, new Date()),
        APP,
      );
    const [r1, r2] = await Promise.all([run(), run()]);

    // 不変条件: 合計でちょうど 1 件だけ新規 down 計上された（二重 INSERT していない）。
    expect(r1.newlyDown + r2.newlyDown).toBe(1);

    // 核心の不変条件（BYPASSRLS 接続で実体を数える）: DEV_A の未解決ダウンタイム行はちょうど 1 行。
    const open = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM tv_device_downtime
      WHERE device_id = ${DEV_A} AND recovered_at IS NULL
    `;
    expect(open[0].n).toBe("1");

    // 同一アウテージで余計な行（締め済み phantom 含む）が増えていないことも確認: DEV_A は合計 1 行のみ。
    const total = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM tv_device_downtime WHERE device_id = ${DEV_A}
    `;
    expect(total[0].n).toBe("1");

    // alert_state も down に揃う。
    const tv = await sql<{ alert_state: string }[]>`
      SELECT alert_state FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(tv[0].alert_state).toBe("down");
  });

  it("runTvLivenessCheck: 復帰時 last_boot_at がダウン後に進んでいれば cause_hint='reboot'", async () => {
    // 5 分前ダウン・down 中・直近で起動報告（last_boot_at = now、last_seen_at より後）→ 復帰。
    await seedDowntime(fx.schoolA, DEV_A, 5);
    await sql`UPDATE tv_devices SET alert_state = 'down', last_seen_at = now() - make_interval(secs => 10), last_boot_at = now() WHERE device_id = ${DEV_A}`;

    await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );

    const rows = await sql<{ cause_hint: string | null }[]>`
      SELECT cause_hint FROM tv_device_downtime WHERE device_id = ${DEV_A}
    `;
    expect(rows[0].cause_hint).toBe("reboot");
  });

  // ---- 長時間サイレンス（schedule-agnostic, dedup 列）: 突入 / send-once / クリア / OFF 非抑制 ----
  // DEFAULT_TV_LONG_SILENCE_SEC = 6h。テストでは make_interval で過去に置く + 既定閾値で判定する。

  it("runTvLivenessCheck: 6h 超 無音で long_silence_notified_at を立て newlyLongSilent=1 / ダウンタイム行は作らない", async () => {
    // 7h 前から無音（既定 6h 閾値超）。alert_state は ok のまま（long-silence は down/recover と独立）。
    await sql`UPDATE tv_devices SET last_seen_at = now() - make_interval(hours => 7) WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.newlyLongSilent).toBe(1);
    expect(summary.longSilentDevices).toHaveLength(1);
    expect(summary.longSilentDevices[0]?.deviceId).toBe(DEV_A);

    // dedup 列が立っている。
    const tv = await sql<{ long_silence_notified_at: string | null }[]>`
      SELECT long_silence_notified_at FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(tv[0].long_silence_notified_at).not.toBeNull();

    // ★運用ダウンタイム表は汚さない（long-silence は tv_device_downtime 行を作らない）。
    const dt = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM tv_device_downtime`;
    expect(dt[0].n).toBe("0");
  });

  it("runTvLivenessCheck: 長時間サイレンスは send-once（再走査で newlyLongSilent=0、列は据置）", async () => {
    await sql`UPDATE tv_devices SET last_seen_at = now() - make_interval(hours => 7) WHERE device_id = ${DEV_A}`;

    const first = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(first.newlyLongSilent).toBe(1);

    // 同じ無音のまま再実行 → 既に列が立っているので新規アラートしない。
    const second = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(second.newlyLongSilent).toBe(0);
    expect(second.longSilenceCleared).toBe(0);
  });

  it("runTvLivenessCheck: 鮮度復帰で long_silence_notified_at を NULL に戻し longSilenceCleared=1（再アラート可能化）", async () => {
    // 列が立っている（前回アラート済み）状態 + 今は鮮度 OK（now）にして復帰させる。
    await sql`UPDATE tv_devices SET last_seen_at = now(), long_silence_notified_at = now() - make_interval(hours => 1) WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.longSilenceCleared).toBe(1);
    expect(summary.newlyLongSilent).toBe(0);

    const tv = await sql<{ long_silence_notified_at: string | null }[]>`
      SELECT long_silence_notified_at FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(tv[0].long_silence_notified_at).toBeNull();
  });

  it("runTvLivenessCheck: OFF スケジュールでも 6h 超 無音は長時間サイレンス検出（down はスキップだが long-silence は塞ぐ）", async () => {
    // schedule を「常に OFF（enabled=false）」にしても long-silence は schedule を無視して検出する。
    // 同時に down/recover は OFF スキップで新規 down を作らない（newlyDown=0）ことも固定する（別シグナルの分離）。
    await sql`
      UPDATE tv_devices
      SET last_seen_at = now() - make_interval(hours => 7),
          schedule_json = '{"enabled":false}'::jsonb,
          alert_state = 'ok'
      WHERE device_id = ${DEV_A}
    `;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    // OFF なので down は計上されない（BUG-2 の意図どおり）。
    expect(summary.newlyDown).toBe(0);
    // だが long-silence は OFF でも検出する（これが本機能の肝＝OFF 盲点を塞ぐ）。
    expect(summary.newlyLongSilent).toBe(1);
    // ダウンタイム行は作らない（long-silence の persistence は dedup 列のみ）。
    const dt = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM tv_device_downtime`;
    expect(dt[0].n).toBe("0");
  });

  it("runTvLivenessCheck: monitoring_enabled=false の 6h 超 無音は長時間サイレンスにしない", async () => {
    await sql`UPDATE tv_devices SET last_seen_at = now() - make_interval(hours => 7), monitoring_enabled = false WHERE device_id = ${DEV_A}`;

    const summary = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => runTvLivenessCheck(tx, new Date()),
      APP,
    );
    expect(summary.newlyLongSilent).toBe(0);
    const tv = await sql<{ long_silence_notified_at: string | null }[]>`
      SELECT long_silence_notified_at FROM tv_devices WHERE device_id = ${DEV_A}
    `;
    expect(tv[0].long_silence_notified_at).toBeNull();
  });
});
