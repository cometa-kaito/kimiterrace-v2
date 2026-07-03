import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "../../src/client.js";
import {
  getForecastByArea,
  getForecastForDay,
  upsertWeatherForecast,
} from "../../src/queries/weather-forecasts.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F14 (#128, ADR-021): weather_forecasts の RLS（公開参照マスタ特例）を実 PG で検証する。
 *
 * 検証の核（Reviewer 重点 / F14 受け入れ条件 §5）:
 *   - **全ロール + 匿名サイネージが SELECT 可**（weather_read_all, USING (true)）。天気は公開・非 PII。
 *     ★ ADR-016 のサイネージ匿名コンテキスト（role 未設定 / school_id のみ or 無し）が確実に読めること。
 *   - **非 system は INSERT / UPDATE / DELETE 不可**（weather_write_system_*）。書込みは system に閉じる。
 *   - **system_admin（取得 Job 経路）は upsert 可**。`(area_code, source, forecast_date)` 競合で UPDATE。
 *
 * 接続ロールは superuser だが、トランザクション内で `SET LOCAL ROLE kimiterrace_app` に降格して RLS を
 * 実際に効かせる（さもないと所有者バイパスで vacuous になる）。
 */
describeOrSkip("RLS: F14 weather_forecasts (#128)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  const AREA = "210000"; // 岐阜県
  const TODAY = "2026-06-02";
  const TOMORROW = "2026-06-03";
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // weather_forecasts は seedBaseFixture の TRUNCATE 対象外（school_id 非保持の cross-tenant 参照で
    // schools CASCADE に巻き込まれない）ため、テスト間で行が残らないよう明示クリアする。
    await sql.unsafe("TRUNCATE weather_forecasts RESTART IDENTITY;");
    // 閲覧テスト用の固定行を owner 接続（RLS バイパス）で投入。
    await sql`
      INSERT INTO weather_forecasts (area_code, area_name, source, forecast_date, weather_code, weather_text, temp_min, temp_max, pop)
      VALUES (${AREA}, '美濃地方', 'jma', ${TODAY}, '100', '晴れ', 18, 28, 30)
    `;
    await sql`
      INSERT INTO weather_forecasts (area_code, area_name, source, forecast_date, weather_code, weather_text, temp_min, temp_max, pop)
      VALUES (${AREA}, '美濃地方', 'jma', ${TOMORROW}, '200', 'くもり', 19, 26, 60)
    `;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- ★ SELECT 全開放（全ロール + 匿名） ---

  it("全テナントロール（school_admin/teacher/student/guardian）が SELECT できる", async () => {
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
        const rows = await tx`SELECT id FROM weather_forecasts WHERE area_code = ${AREA}`;
        expect(rows.length, `role=${role}`).toBe(2);
      });
    }
  });

  it("★ サイネージ匿名コンテキスト（role 未設定・school_id のみ）でも SELECT できる（ADR-016）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      // school_id のみ set、role / userId は set しない（匿名サイネージ = deny-by-default 接続）。
      // 天気は cross-tenant 共有なので school_id に関係なく weather_read_all で読める。
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      const rows = await tx`SELECT id FROM weather_forecasts WHERE area_code = ${AREA}`;
      expect(rows.length).toBe(2);
    });
  });

  it("context 完全無し（role も school_id も無し）でも SELECT できる（公開データ、USING true）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx`SELECT id FROM weather_forecasts WHERE area_code = ${AREA}`;
      expect(rows.length).toBe(2);
    });
  });

  // --- ★ 書き込みは system のみ ---

  it("非 system（school_admin）は INSERT できない（weather_write_system_insert）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', '00000000-0000-0000-0000-000000000001', true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO weather_forecasts (area_code, source, forecast_date, weather_code)
          VALUES ('999999', 'jma', ${TODAY}, '100')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("匿名（role 無し）も INSERT できない（deny-by-default）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`
          INSERT INTO weather_forecasts (area_code, source, forecast_date, weather_code)
          VALUES ('999999', 'jma', ${TODAY}, '100')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("非 system（teacher）は UPDATE / DELETE できない（0 行 or 拒否、漏洩・改竄防止）", async () => {
    // UPDATE: weather_write_system_update の USING が false → 0 行（エラーにはならないが変更不可）。
    const updated = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx`UPDATE weather_forecasts SET weather_text = '改竄' WHERE area_code = ${AREA} RETURNING id`;
    });
    expect(updated.length).toBe(0);

    const deleted = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx`DELETE FROM weather_forecasts WHERE area_code = ${AREA} RETURNING id`;
    });
    expect(deleted.length).toBe(0);

    // owner 接続で 2 行が無傷であることを確認。
    await sql`RESET ROLE`;
    const survive = await sql`SELECT weather_text FROM weather_forecasts WHERE area_code = ${AREA}`;
    expect(survive.length).toBe(2);
  });

  // --- ★ system_admin（取得 Job 経路）の upsert ---

  it("upsertWeatherForecast: system context で INSERT、競合キーで UPDATE（last-known-good 更新）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    const NEW_AREA = "130000"; // 東京都（fixture に無い新規）
    try {
      const db = drizzle(client);
      // 1) 新規 INSERT（system context）。
      const id1 = await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertWeatherForecast(tx, {
            areaCode: NEW_AREA,
            areaName: "東京地方",
            forecastDate: TODAY,
            weatherCode: "100",
            weatherText: "晴れ",
            tempMin: 20,
            tempMax: 29,
            pop: 10,
            raw: { v: 1 },
          }),
        { appRole: "kimiterrace_app" },
      );
      expect(id1).toMatch(/^[0-9a-f-]{36}$/);

      // 2) 同一 (area_code, source, forecast_date) で再 upsert → UPDATE（同 id、値差し替え）。
      const id2 = await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertWeatherForecast(tx, {
            areaCode: NEW_AREA,
            forecastDate: TODAY,
            weatherCode: "300",
            weatherText: "雨",
            pop: 80,
            raw: { v: 2 },
          }),
        { appRole: "kimiterrace_app" },
      );
      expect(id2).toBe(id1); // upsert で行は増えない

      // owner 接続で結果検証（1 行・最新値・created/updated の監査整合）。
      await client.unsafe("RESET ROLE");
      const rows = await client<
        {
          weather_text: string;
          pop: number;
          created_by: string | null;
          updated_at: Date;
          created_at: Date;
        }[]
      >`SELECT weather_text, pop, created_by, created_at, updated_at FROM weather_forecasts WHERE area_code = ${NEW_AREA}`;
      expect(rows.length).toBe(1);
      expect(rows[0].weather_text).toBe("雨");
      expect(rows[0].pop).toBe(80);
      expect(rows[0].created_by).toBeNull(); // システム書き込み（ルール1: システム作成は null）
      // ルール1: UPDATE で updated_at を明示更新（created_at より後）。
      expect(new Date(rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[0].created_at).getTime(),
      );
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("★ upsert: 気温だけ null の再取得は既存気温を保持する（JMA 夕方版の本日気温落ちで「—」にしない）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    const AREA_TEMP = "230000"; // 愛知県（fixture・他テストと非衝突の新規）
    try {
      const db = drizzle(client);
      // 1) 朝版相当: 本日の実気温付きで INSERT（tempMin=21, tempMax=30）。
      await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertWeatherForecast(tx, {
            areaCode: AREA_TEMP,
            forecastDate: TODAY,
            weatherCode: "100",
            weatherText: "晴れ",
            tempMin: 21,
            tempMax: 30,
            pop: 10,
          }),
        { appRole: "kimiterrace_app" },
      );

      // 2) 夕方版相当: 同一対象日を天気のみ（tempMin/tempMax 未指定 = null）で再 upsert。
      //    ★ 修正の核: 気温は null で上書きせず既存(21/30)を保持する。
      await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertWeatherForecast(tx, {
            areaCode: AREA_TEMP,
            forecastDate: TODAY,
            weatherCode: "111",
            weatherText: "晴れ夕方くもり",
            pop: 20,
          }),
        { appRole: "kimiterrace_app" },
      );

      await client.unsafe("RESET ROLE");
      const afterNull = await client<
        { temp_min: number | null; temp_max: number | null; weather_text: string; pop: number }[]
      >`SELECT temp_min, temp_max, weather_text, pop FROM weather_forecasts WHERE area_code = ${AREA_TEMP}`;
      expect(afterNull.length).toBe(1);
      expect(afterNull[0].temp_min).toBe(21); // ★ 保持（null で潰さない）
      expect(afterNull[0].temp_max).toBe(30); // ★ 保持
      expect(afterNull[0].weather_text).toBe("晴れ夕方くもり"); // 天気は新値で上書き
      expect(afterNull[0].pop).toBe(20); // 降水確率も新値で上書き

      // 3) 新しい非 null 気温が来たら従来どおり上書きされる（正当な更新・訂正は反映）。
      await withTenantContext(
        db,
        { role: "system_admin" },
        (tx) =>
          upsertWeatherForecast(tx, {
            areaCode: AREA_TEMP,
            forecastDate: TODAY,
            tempMin: 23,
            tempMax: 28,
          }),
        { appRole: "kimiterrace_app" },
      );
      await client.unsafe("RESET ROLE");
      const afterUpdate = await client<
        { temp_min: number | null; temp_max: number | null }[]
      >`SELECT temp_min, temp_max FROM weather_forecasts WHERE area_code = ${AREA_TEMP}`;
      expect(afterUpdate.length).toBe(1); // upsert なので 1 行のまま
      expect(afterUpdate[0].temp_min).toBe(23); // 非 null は上書き
      expect(afterUpdate[0].temp_max).toBe(28);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("getForecastByArea: 匿名サイネージ context で本日以降を昇順に読む（過去日を除外）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      // 過去日の行を追加（owner 接続）。
      await client.unsafe("RESET ROLE");
      await client`
        INSERT INTO weather_forecasts (area_code, source, forecast_date, weather_code)
        VALUES (${AREA}, 'jma', '2026-06-01', '100')
      `;
      const rows = await db.transaction(async (tx) => {
        // 匿名サイネージ context（role 無し）に降格。weather_read_all で読めることを実証。
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        return getForecastByArea(tx, AREA, TODAY);
      });
      // TODAY 以降の 2 行のみ（過去 6/1 は除外）、forecast_date 昇順。
      expect(rows.map((r) => r.forecastDate)).toEqual([TODAY, TOMORROW]);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("getForecastForDay: 指定日 1 件 / 無い日は null", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const found = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        return getForecastForDay(tx, AREA, TODAY);
      });
      expect(found?.weatherText).toBe("晴れ");
      const missing = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        return getForecastForDay(tx, AREA, "2999-01-01");
      });
      expect(missing).toBeNull();
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });
});
