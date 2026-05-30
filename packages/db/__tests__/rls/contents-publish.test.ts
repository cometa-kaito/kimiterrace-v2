import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  ContentNotFoundError,
  NoActivePublishError,
  VersionNotFoundError,
  publishContent,
  rollbackContent,
  unpublishContent,
  updateContent,
} from "../../src/queries/contents-publish.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F04: 即公開フロー + 安全網のドメインサービスを実 PG (RLS 込み) で検証する。
 *
 * 接続は DATABASE_URL の superuser (BYPASSRLS) なので、appRole で kimiterrace_app へ降格して
 * から RLS を効かせる (本番は最初から kimiterrace_app 接続のため appRole 不要)。
 */
describeOrSkip("F04 publish flow (publish / update / unpublish / rollback + audit)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let contentA: string;

  /** school A の draft content を 1 件作り直す (BYPASSRLS 接続で投入)。 */
  async function seedDraftA(): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${fx.schoolA}, '体育祭のお知らせ', '初版本文', 'school', 'draft', ${fx.userA})
      RETURNING id
    `;
    return row.id;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    // 各テストを独立させるため content 系を作り直す (audit_log は append-only なので残す)。
    await raw`DELETE FROM publishes`;
    await raw`DELETE FROM content_versions`;
    await raw`DELETE FROM contents`;
    contentA = await seedDraftA();
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  // fx は beforeAll で代入されるため、collection 時 (describe 本体評価) に fx.* を読む
  // 即時オブジェクトは undefined アクセスで落ちる。actorA / ctxA は遅延 (関数) にして
  // テスト実行時 (= beforeAll 後) に fx を読む。
  const actorA = () => ({ userId: fx.userA, schoolId: fx.schoolA });
  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "teacher" as const });

  it("publishContent: status=published + publishes 行 + version + audit を追記する", async () => {
    const result = await withTenantContext(
      db,
      ctxA(),
      (tx) => publishContent(tx, actorA(), contentA),
      APP,
    );
    expect(result.publishId).toBeTruthy();
    expect(result.version).toBe(1);

    const [c] = await raw<{ status: string }[]>`SELECT status FROM contents WHERE id = ${contentA}`;
    expect(c.status).toBe("published");

    const pubs = await raw`SELECT id FROM publishes WHERE content_id = ${contentA}`;
    expect(pubs.length).toBe(1);

    const audits = await raw`
      SELECT actor_user_id, operation, table_name FROM audit_log
      WHERE table_name = 'publishes' AND actor_user_id = ${fx.userA}
    `;
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].operation).toBe("insert");
  });

  it("updateContent: contents を更新し新バージョンを追記、audit に before/after が残る", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    const upd = await withTenantContext(
      db,
      ctxA(),
      (tx) => updateContent(tx, actorA(), contentA, { body: "改訂本文" }),
      APP,
    );
    expect(upd.version).toBe(2);

    const [c] = await raw<{ body: string }[]>`SELECT body FROM contents WHERE id = ${contentA}`;
    expect(c.body).toBe("改訂本文");

    const versions =
      await raw`SELECT version FROM content_versions WHERE content_id = ${contentA} ORDER BY version`;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);

    const [audit] = await raw<{ diff: { before: { body: string }; after: { body: string } } }[]>`
      SELECT diff FROM audit_log WHERE table_name = 'contents' AND operation = 'update'
      ORDER BY occurred_at DESC LIMIT 1
    `;
    expect(audit.diff.before.body).toBe("初版本文");
    expect(audit.diff.after.body).toBe("改訂本文");
  });

  it("rollbackContent: 旧バージョン本文を復元しつつ履歴を消さず新バージョンを積む (F04.2)", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP); // v1 = 初版本文
    await withTenantContext(
      db,
      ctxA(),
      (tx) => updateContent(tx, actorA(), contentA, { body: "改訂本文" }),
      APP,
    ); // v2 = 改訂本文

    const rb = await withTenantContext(
      db,
      ctxA(),
      (tx) => rollbackContent(tx, actorA(), contentA, 1),
      APP,
    );
    expect(rb.version).toBe(3);
    expect(rb.restoredFrom).toBe(1);

    const [c] = await raw<{ body: string }[]>`SELECT body FROM contents WHERE id = ${contentA}`;
    expect(c.body).toBe("初版本文"); // v1 の内容に戻った

    // 履歴は失わない: v1/v2/v3 すべて残る
    const versions =
      await raw`SELECT version FROM content_versions WHERE content_id = ${contentA} ORDER BY version`;
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("unpublishContent: 公開中 publish を閉じ status=archived、audit に update を残す", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    await withTenantContext(db, ctxA(), (tx) => unpublishContent(tx, actorA(), contentA), APP);

    const [c] = await raw<{ status: string }[]>`SELECT status FROM contents WHERE id = ${contentA}`;
    expect(c.status).toBe("archived");

    const [p] = await raw<{ unpublished_at: Date | null }[]>`
      SELECT unpublished_at FROM publishes WHERE content_id = ${contentA}
    `;
    expect(p.unpublished_at).not.toBeNull();
  });

  it("unpublishContent: 公開中 publish が無ければ NoActivePublishError", async () => {
    await expect(
      withTenantContext(db, ctxA(), (tx) => unpublishContent(tx, actorA(), contentA), APP),
    ).rejects.toBeInstanceOf(NoActivePublishError);
  });

  it("rollbackContent: 存在しないバージョンは VersionNotFoundError", async () => {
    await expect(
      withTenantContext(db, ctxA(), (tx) => rollbackContent(tx, actorA(), contentA, 99), APP),
    ).rejects.toBeInstanceOf(VersionNotFoundError);
  });

  it("テナント分離: 別校 (B) からは A の content が見えず ContentNotFoundError (RLS)", async () => {
    const ctxB = { userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const };
    const actorB = { userId: fx.userB, schoolId: fx.schoolB };
    await expect(
      withTenantContext(db, ctxB, (tx) => publishContent(tx, actorB, contentA), APP),
    ).rejects.toBeInstanceOf(ContentNotFoundError);
  });

  it("テナント分離: B のコンテキストでは A の publishes / version が作られていない", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    // B コンテキストで A の content を rollback 試行 → 不可視で例外、B 側に副作用ゼロ
    const ctxB = { userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const };
    const actorB = { userId: fx.userB, schoolId: fx.schoolB };
    await expect(
      withTenantContext(db, ctxB, (tx) => rollbackContent(tx, actorB, contentA, 1), APP),
    ).rejects.toBeInstanceOf(ContentNotFoundError);

    // A の publishes は 1 件のまま (B の操作で増えていない)
    const pubs = await raw`SELECT id FROM publishes WHERE content_id = ${contentA}`;
    expect(pubs.length).toBe(1);
  });

  it("audit_log の actor_user_id は常に操作者本人 (詐称防止 policy を充足)", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    const rows = await raw<{ actor_user_id: string }[]>`
      SELECT DISTINCT actor_user_id FROM audit_log WHERE school_id = ${fx.schoolA}
    `;
    for (const r of rows) {
      expect(r.actor_user_id).toBe(fx.userA);
    }
  });

  it("publish → publishes.version_id が実在の content_versions を指す (整合)", async () => {
    const { versionId } = await withTenantContext(
      db,
      ctxA(),
      (tx) => publishContent(tx, actorA(), contentA),
      APP,
    );
    const [v] = await raw`SELECT id FROM content_versions WHERE id = ${versionId}`;
    expect(v).toBeTruthy();
  });
});
