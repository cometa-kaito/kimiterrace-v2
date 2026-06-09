import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  claimNextProvisioningJob,
  createProvisioningJob,
  getProvisioningJob,
  listProvisioningJobs,
  reportProvisioningStatus,
} from "../../src/queries/tv-provisioning-jobs.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * C方式 TV プロビジョニングジョブ tv_provisioning_jobs の RLS テナント分離 + claim（FOR UPDATE SKIP LOCKED、
 * cross-tenant 解決）+ status 報告の認可（claim したエージェントのみ）を実 PG で検証する。
 *
 * セキュリティの核心を pin する:
 *  - **作成は system_admin（cross-tenant）**: createProvisioningJob は任意校向けジョブを作成し監査を残す。
 *  - **テナント分離（読取）**: 自校 context は自校ジョブのみ、他校は不可視。
 *  - **WITH CHECK**: 生 INSERT で他校 school_id を書くと拒否。
 *  - **claim は最古の pending を 1 件・cross-tenant**、尽きたら null。
 *  - **status 報告は claimed_by 一致必須**: 他エージェントの jobId は更新できない（状態詐称防止）。
 *  - **deny-by-default**: context 未設定では 0 件。
 *
 * 実 PG（DATABASE_URL）でのみ走り未設定ならスキップ（ADR-012）。ドメイン関数は `appRole: 'kimiterrace_app'`
 * でテスト superuser を降格させ RLS を実効させる。UUID 定数は他テストと重複しない名前空間（d 系）を使う。
 */
describeOrSkip("RLS: C方式 tv_provisioning_jobs", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  // system_admin 監査 actor の Identity Platform UID（users 行は無い）。
  const SYSADMIN_UID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  /** 指定校テナント context（非 BYPASSRLS）でジョブ件数を読む。 */
  async function countJobsAs(schoolId: string): Promise<number> {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
      const rows = await tx<{ c: string }[]>`SELECT count(*)::text AS c FROM tv_provisioning_jobs`;
      return Number(rows[0].c);
    });
  }

  /** system_admin context で指定校向けジョブを 1 件作成し id を返す。 */
  async function createJobFor(schoolId: string, deviceId?: string): Promise<string> {
    const r = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) =>
        createProvisioningJob(tx, {
          schoolId,
          deviceId: deviceId ?? null,
          targetIp: "192.168.1.50",
          targetMac: "DC:A5:B3:C2:98:D7",
          signageUrl: "https://app.school-signage.net/signage/tok",
          actorUserId: null,
          actorIdentityUid: SYSADMIN_UID,
        }),
      APP,
    );
    return r.id;
  }

  it("createProvisioningJob: system_admin が school A 向けに作成 → A から見え B から見えない + 監査1件", async () => {
    await createJobFor(fx.schoolA, "dev-A-1");
    expect(await countJobsAs(fx.schoolA)).toBe(1);
    expect(await countJobsAs(fx.schoolB)).toBe(0);

    // 監査が 1 件残る（school=A, insert, actor_user_id は system_admin ゆえ null、ルール1）。
    const audit = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      return await tx<{ school_id: string; operation: string; actor_user_id: string | null }[]>`
        SELECT school_id, operation, actor_user_id FROM audit_log WHERE table_name = 'tv_provisioning_jobs'
      `;
    });
    expect(audit.length).toBe(1);
    expect(audit[0].school_id).toBe(fx.schoolA);
    expect(audit[0].operation).toBe("insert");
    expect(audit[0].actor_user_id).toBeNull();
  });

  it("生 INSERT で他校 school_id を書くと WITH CHECK で拒否される（tenant_isolation）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO tv_provisioning_jobs (school_id, status) VALUES (${fx.schoolB}, 'pending')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("context 未設定 → 全件拒否（deny by default）", async () => {
    await createJobFor(fx.schoolA);
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM tv_provisioning_jobs`;
      expect(rows.length).toBe(0);
    });
  });

  it("claimNextProvisioningJob: 古い順に pending を claim（cross-tenant）、尽きたら null", async () => {
    const id1 = await createJobFor(fx.schoolA, "dev-claim-1");
    // 別 tx で 2 件目（created_at を確実に後にする）。school B 向け = cross-tenant claim も確認。
    const id2 = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) =>
        createProvisioningJob(tx, {
          schoolId: fx.schoolB,
          deviceId: "dev-claim-2",
          actorUserId: null,
          actorIdentityUid: SYSADMIN_UID,
        }),
      APP,
    ).then((r) => r.id);

    const first = await claimNextProvisioningJob(db, "agent-1", APP);
    expect(first?.id).toBe(id1);
    expect(first?.schoolId).toBe(fx.schoolA);
    const second = await claimNextProvisioningJob(db, "agent-1", APP);
    expect(second?.id).toBe(id2);
    expect(second?.schoolId).toBe(fx.schoolB);
    const third = await claimNextProvisioningJob(db, "agent-1", APP);
    expect(third).toBeNull();

    // claimed_by / status が反映されている（BYPASSRLS で裏取り）。
    const rows = await sql<{ status: string; claimed_by: string | null }[]>`
      SELECT status, claimed_by FROM tv_provisioning_jobs WHERE id = ${id1}
    `;
    expect(rows[0].status).toBe("claimed");
    expect(rows[0].claimed_by).toBe("agent-1");
  });

  it("reportProvisioningStatus: claim したエージェントのみ更新可（他エージェントは not_found）", async () => {
    const id = await createJobFor(fx.schoolA, "dev-report");
    await claimNextProvisioningJob(db, "agent-X", APP);

    const ok = await reportProvisioningStatus(
      db,
      {
        jobId: id,
        agentId: "agent-X",
        status: "preflight",
        currentStep: "県Wi-Fi設定キャプチャ",
        step: { name: "preflight", status: "ok", detail: { factoryMacMatch: true } },
      },
      APP,
    );
    expect(ok.status).toBe("updated");

    // 別エージェントは claimed_by 不一致で not_found（状態詐称防止）。
    const spoof = await reportProvisioningStatus(
      db,
      { jobId: id, agentId: "agent-OTHER", status: "failed" },
      APP,
    );
    expect(spoof.status).toBe("not_found");

    const after = await sql<{ status: string; current_step: string | null; steps_json: unknown }[]>`
      SELECT status, current_step, steps_json FROM tv_provisioning_jobs WHERE id = ${id}
    `;
    expect(after[0].status).toBe("preflight");
    expect(after[0].current_step).toBe("県Wi-Fi設定キャプチャ");
    expect(Array.isArray(after[0].steps_json)).toBe(true);
    expect((after[0].steps_json as { name: string }[]).length).toBe(1);
  });

  it("listProvisioningJobs / getProvisioningJob: RLS スコープ（A は自校のみ、system_admin は全校）", async () => {
    await createJobFor(fx.schoolA, "dev-list-A");
    await createJobFor(fx.schoolB, "dev-list-B");

    // school A context は自校のみ。
    const aList = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "school_admin" },
      (tx) => listProvisioningJobs(tx),
      APP,
    );
    expect(aList.length).toBe(1);
    expect(aList[0].schoolId).toBe(fx.schoolA);

    // system_admin は全校。
    const allList = await withTenantContext(
      db,
      { role: "system_admin" },
      (tx) => listProvisioningJobs(tx),
      APP,
    );
    expect(allList.length).toBe(2);

    // getProvisioningJob: A のジョブを他校(B) context で取ると不可視 → null。
    const aId = aList[0].id;
    const cross = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "school_admin" },
      (tx) => getProvisioningJob(tx, aId),
      APP,
    );
    expect(cross).toBeNull();
  });
});
