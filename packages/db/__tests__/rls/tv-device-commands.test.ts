import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  ackTvCommand,
  enqueueTvCommand,
  listRecentTvCommands,
  pollPendingTvCommands,
} from "../../src/queries/tv-device-commands.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F15 (ADR-022): TV リモートコマンドキュー tv_device_commands の RLS テナント分離 + ポーリング配信
 * （cross-tenant 解決）+ 冪等 ack を実 PG で検証する。
 *
 * セキュリティの核心を pin する:
 *  - **発行は自校スコープ（RLS 委譲）**: enqueueTvCommand は自校 device にのみキューイングできる。
 *  - **cross-tenant 発行は拒否**: 他校 device 行は不可視 → device_not_found（解決段で 0 行）。
 *    生 INSERT で他校 school_id を書こうとすると WITH CHECK で拒否される。
 *  - **配信は device_id で cross-tenant 解決し、自分宛の pending のみ**返る（他デバイスのは混ざらない）。
 *  - **ack は冪等**: pending→delivered の 1 回のみ。再 ack は already_acked。
 *  - **deny-by-default**: context 未設定では 0 件。
 *
 * すべて実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。ドメイン関数は
 * `appRole: 'kimiterrace_app'` でテスト superuser を降格させ RLS を実効させる（さもないと vacuous）。
 * `sql`（BYPASSRLS スーパーユーザー）はシード/検証専用。
 *
 * UUID 定数は他テストファイル（tv-devices.test.ts の 1111.../2222...）と **重複しない名前空間**を使う
 * （単一フォーク共有 DB のため）。device は a/b 系、command id は c 系。
 */
describeOrSkip("RLS: F15 tv_device_commands", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  // 他ファイルと衝突しない device_id（a/b 系）。
  const DEV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const DEV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  // device 行 PK を保持（enqueue/list は行 PK 入力）。
  let rowA = "";
  let rowB = "";

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    await sql`RESET ROLE`;
    // 各校に TV 1 台ずつ（BYPASSRLS = テーブル所有者接続でシード）。行 PK を控える。
    const [a] = await sql<{ id: string }[]>`
      INSERT INTO tv_devices (school_id, device_id, label) VALUES (${fx.schoolA}, ${DEV_A}, '電子工学科 1年')
      RETURNING id
    `;
    const [b] = await sql<{ id: string }[]>`
      INSERT INTO tv_devices (school_id, device_id, label) VALUES (${fx.schoolB}, ${DEV_B}, '職員室')
      RETURNING id
    `;
    rowA = a.id;
    rowB = b.id;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  /** 指定校テナント context（非 BYPASSRLS）でコマンド件数を読む。 */
  async function countCommandsAs(schoolId: string): Promise<number> {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ c: string }[]>`SELECT count(*)::text AS c FROM tv_device_commands`;
      return Number(rows[0].c);
    });
  }

  it("enqueueTvCommand: 自校 device にキューイング、他校(B)からは見えない（テナント分離 + 監査）", async () => {
    const r = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        }),
      APP,
    );
    expect(r.status).toBe("enqueued");
    if (r.status === "enqueued") expect(r.deviceId).toBe(DEV_A);
    expect(await countCommandsAs(fx.schoolA)).toBe(1);
    expect(await countCommandsAs(fx.schoolB)).toBe(0);

    // 監査が 1 件残る（actor=A, school=A, operation=insert、ルール1）。
    const audit = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      return await tx<{ actor_user_id: string; school_id: string; operation: string }[]>`
        SELECT actor_user_id, school_id, operation FROM audit_log WHERE table_name = 'tv_device_commands'
      `;
    });
    expect(audit.length).toBe(1);
    expect(audit[0].actor_user_id).toBe(fx.userA);
    expect(audit[0].school_id).toBe(fx.schoolA);
    expect(audit[0].operation).toBe("insert");
  });

  it("enqueueTvCommand: 他校 device の行 PK は不可視 → device_not_found（cross-tenant 発行不可）", async () => {
    const r = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowB, // B 校の device を A 校 context で指す
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        }),
      APP,
    );
    expect(r.status).toBe("device_not_found");
    expect(await countCommandsAs(fx.schoolA)).toBe(0);
    expect(await countCommandsAs(fx.schoolB)).toBe(0);
  });

  it("生 INSERT で他校 school_id を書くと WITH CHECK で拒否される", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO tv_device_commands (device_id, school_id, command)
          VALUES (${DEV_B}, ${fx.schoolB}, 'signage_reload')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("context 未設定 → 全件拒否（0 件、deny by default）", async () => {
    // 先に 1 件発行しておく（system_admin 経路）。
    await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        }),
      APP,
    );
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM tv_device_commands`;
      expect(rows.length).toBe(0);
    });
  });

  it("pollPendingTvCommands: device_id で自分宛の pending のみ返る（他デバイスは混ざらない）", async () => {
    // A 校 device に 2 件（reload, restart）、B 校 device に 1 件発行。
    await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      async (tx) => {
        await enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        });
        await enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "service_restart",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        });
      },
      APP,
    );
    await withTenantContext(
      db,
      { userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowB,
          command: "signage_exit",
          actorUserId: fx.userB,
          actorSchoolId: fx.schoolB,
        }),
      APP,
    );

    const aCmds = await pollPendingTvCommands(db, DEV_A, APP);
    expect(aCmds.length).toBe(2);
    // 発行順（issued_at 昇順）で返る。
    expect(aCmds.map((c) => c.command)).toEqual(["signage_reload", "service_restart"]);

    const bCmds = await pollPendingTvCommands(db, DEV_B, APP);
    expect(bCmds.length).toBe(1);
    expect(bCmds[0].command).toBe("signage_exit");
  });

  it("pollPendingTvCommands: 失効済み（expires_at 過去）の pending は配信しない", async () => {
    await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        }),
      APP,
    );
    // 行を過去 expires_at に直接ずらす（DB 側で算出、JS Date を bind しない）。
    await sql`
      UPDATE tv_device_commands SET expires_at = now() - make_interval(mins => 1) WHERE device_id = ${DEV_A}
    `;
    const aCmds = await pollPendingTvCommands(db, DEV_A, APP);
    expect(aCmds.length).toBe(0);
  });

  it("ackTvCommand: pending→delivered を冪等に行う（再 ack は already_acked）", async () => {
    const enq = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        }),
      APP,
    );
    expect(enq.status).toBe("enqueued");
    const commandId = enq.status === "enqueued" ? enq.id : "";

    const first = await ackTvCommand(db, { commandId, deviceId: DEV_A }, APP);
    expect(first.status).toBe("acked");
    const second = await ackTvCommand(db, { commandId, deviceId: DEV_A }, APP);
    expect(second.status).toBe("already_acked");

    // 行は delivered + acknowledged_at セット（BYPASSRLS で検証）。pending は配信対象から外れる。
    const after = await sql<{ status: string; acknowledged_at: string | null }[]>`
      SELECT status, acknowledged_at FROM tv_device_commands WHERE id = ${commandId}
    `;
    expect(after[0].status).toBe("delivered");
    expect(after[0].acknowledged_at).not.toBeNull();
    expect((await pollPendingTvCommands(db, DEV_A, APP)).length).toBe(0);
  });

  it("ackTvCommand: device_id 不一致 / 存在しない id は not_found（他デバイスの id を ack できない）", async () => {
    const enq = await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      (tx) =>
        enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        }),
      APP,
    );
    const commandId = enq.status === "enqueued" ? enq.id : "";
    // 正しい id だが別 device_id を指す → not_found（id は A 宛、B として ack 不可）。
    const mismatch = await ackTvCommand(db, { commandId, deviceId: DEV_B }, APP);
    expect(mismatch.status).toBe("not_found");
    // 存在しない id → not_found。
    const ghost = await ackTvCommand(
      db,
      { commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", deviceId: DEV_A },
      APP,
    );
    expect(ghost.status).toBe("not_found");
  });

  it("listRecentTvCommands: 自校 device の履歴を新しい順に返す（RLS スコープ、他校は空）", async () => {
    await withTenantContext(
      db,
      { userId: fx.userA, schoolId: fx.schoolA, role: "school_admin" },
      async (tx) => {
        await enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "signage_reload",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        });
        await enqueueTvCommand(tx, {
          deviceRowId: rowA,
          command: "service_restart",
          actorUserId: fx.userA,
          actorSchoolId: fx.schoolA,
        });
      },
      APP,
    );
    const aHist = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => listRecentTvCommands(tx, rowA),
      APP,
    );
    expect(aHist.length).toBe(2);
    // 新しい順（issued_at 降順）。
    expect(aHist[0].command).toBe("service_restart");

    // 他校(B) context で A の device 行 PK を渡すと RLS で device 解決が 0 行 → 空配列。
    const cross = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "school_admin" },
      (tx) => listRecentTvCommands(tx, rowA),
      APP,
    );
    expect(cross.length).toBe(0);
  });
});
