import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getTodayPresenceCount } from "../../src/queries/presence-today.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * パターン2「人感センサカウンタ」read 層を実 PG（RLS 込み）で検証する（F13 / ADR-020）。
 *
 * 観点: (1) クラス別・本日(JST)の presence 件数の集計正当性、(2) 別クラス/別日/別種別/class未割当の除外、
 * (3) **テナント分離** — 別校の presence が漏れないこと（ルール2）、(4) 空コンテキストは deny-by-default で 0、
 * (5) 検知ゼロは 0。class_id は `events.payload.class_id`（jsonb）に格納される（列は無い）。
 */
describeOrSkip("getTodayPresenceCount（パターン2 人感センサ・RLS + JST + class）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let today: string;

  // payload.class_id に入れる任意の UUID（FK は無い＝jsonb 値なので実 classes 行は不要）。
  const CLASS_A1 = "aaaa1111-1111-4111-8111-111111111111";
  const CLASS_A2 = "aaaa2222-2222-4222-8222-222222222222";
  const CLASS_B1 = "bbbb1111-1111-4111-8111-111111111111";

  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" as const });
  const ctxB = () => ({ userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" as const });

  // presence を JST の `daysAgo` 日前 12:00 + `minute` 分に投入する。`minute` で occurred_at を一意化し
  // presence dedup index（ux_events_presence_dedup）との衝突を避ける。class_id は payload（jsonb）へ。
  // JS Date を bind せず全て SQL 側で時刻計算する（[[pg-date-bind-enum-insert]] と同方針）。
  async function seedPresence(
    schoolId: string,
    classId: string | null,
    daysAgo: number,
    minute: number,
  ): Promise<void> {
    const payload = JSON.stringify({ source: "switchbot", class_id: classId });
    await raw`
      INSERT INTO events (school_id, type, occurred_at, payload)
      VALUES (
        ${schoolId}, 'presence',
        (date_trunc('day', now() at time zone 'Asia/Tokyo')
          - make_interval(days => ${daysAgo}::int)
          + make_interval(hours => 12, mins => ${minute}::int)) at time zone 'Asia/Tokyo',
        ${payload}::jsonb
      )
    `;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
    // 「本日」の JST 暦日を DB から取得（クエリ側と同じ now() 基準で揃え、JS タイムゾーン差を避ける）。
    const [row] = await raw<{ today: string }[]>`
      SELECT to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD') AS today
    `;
    today = row.today;
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM events`;
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("本日(JST)の対象クラスの presence 件数だけ数える（別クラス/別日/class未割当/別種別は除外）", async () => {
    await seedPresence(fx.schoolA, CLASS_A1, 0, 1); // 今日・A1
    await seedPresence(fx.schoolA, CLASS_A1, 0, 2); // 今日・A1
    await seedPresence(fx.schoolA, CLASS_A1, 0, 3); // 今日・A1（計3）
    await seedPresence(fx.schoolA, CLASS_A2, 0, 4); // 今日・別クラス → 除外
    await seedPresence(fx.schoolA, CLASS_A1, 1, 5); // 昨日・A1 → 除外
    await seedPresence(fx.schoolA, null, 0, 6); // 今日・class未割当 → 除外
    // presence 以外（view）は数えない。
    await raw`INSERT INTO events (school_id, type, occurred_at) VALUES (${fx.schoolA}, 'view', now())`;

    const n = await withTenantContext(
      db,
      ctxA(),
      (tx) => getTodayPresenceCount(tx, CLASS_A1, today),
      APP,
    );
    expect(n).toBe(3);
  });

  it("検知ゼロは 0 を返す（センサーは在るが今日まだ反応なし）", async () => {
    const n = await withTenantContext(
      db,
      ctxA(),
      (tx) => getTodayPresenceCount(tx, CLASS_A1, today),
      APP,
    );
    expect(n).toBe(0);
  });

  it("テナント分離: A コンテキストから B 校の presence は数えない（RLS）", async () => {
    await seedPresence(fx.schoolA, CLASS_A1, 0, 1);
    await seedPresence(fx.schoolB, CLASS_B1, 0, 1);
    await seedPresence(fx.schoolB, CLASS_B1, 0, 2);

    const a = await withTenantContext(
      db,
      ctxA(),
      (tx) => getTodayPresenceCount(tx, CLASS_A1, today),
      APP,
    );
    expect(a).toBe(1);
    const b = await withTenantContext(
      db,
      ctxB(),
      (tx) => getTodayPresenceCount(tx, CLASS_B1, today),
      APP,
    );
    expect(b).toBe(2);
  });

  it("空コンテキストは deny-by-default で 0", async () => {
    await seedPresence(fx.schoolA, CLASS_A1, 0, 1);
    const n = await withTenantContext(
      db,
      {},
      (tx) => getTodayPresenceCount(tx, CLASS_A1, today),
      APP,
    );
    expect(n).toBe(0);
  });
});
