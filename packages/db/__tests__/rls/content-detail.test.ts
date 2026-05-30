import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getContentDetail, listContents } from "../../src/queries/content-detail.js";
import {
  publishContent,
  unpublishContent,
  updateContent,
} from "../../src/queries/contents-publish.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F04: content 読み取りクエリ層を実 PG (RLS 込み) で検証する。状態づくりは publish サービス
 * (publish/update/unpublish) を使い、read 層がそれを正しく射影できるかをクロス検証する。
 */
describeOrSkip("F04 content-detail read queries (一覧 / 詳細 + version + 公開状態)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: raw, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" };
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let contentA: string;

  const actorA = () => ({ userId: fx.userA, schoolId: fx.schoolA });
  const ctxA = () => ({ userId: fx.userA, schoolId: fx.schoolA, role: "teacher" as const });

  async function seedDraft(title: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      INSERT INTO contents (school_id, title, body, publish_scope, status, created_by)
      VALUES (${fx.schoolA}, ${title}, '初版本文', 'school', 'draft', ${fx.userA})
      RETURNING id
    `;
    return row.id;
  }

  beforeAll(async () => {
    fx = await seedBaseFixture(raw);
  });

  beforeEach(async () => {
    await raw`RESET ROLE`;
    await raw`DELETE FROM publishes`;
    await raw`DELETE FROM content_versions`;
    await raw`DELETE FROM contents`;
    contentA = await seedDraft("体育祭のお知らせ");
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  it("getContentDetail: publish→update 後に本体 + version 降順 + 公開中 publish を返す", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP); // v1
    await withTenantContext(
      db,
      ctxA(),
      (tx) => updateContent(tx, actorA(), contentA, { body: "改訂本文" }),
      APP,
    ); // v2

    const detail = await withTenantContext(db, ctxA(), (tx) => getContentDetail(tx, contentA), APP);
    expect(detail).not.toBeNull();
    expect(detail?.content.body).toBe("改訂本文");
    expect(detail?.content.status).toBe("published");
    // version 降順 (新しい順)
    expect(detail?.versions.map((v) => v.version)).toEqual([2, 1]);
    // 公開中 publish が v1 を指す (publish 時点の最新版)
    expect(detail?.activePublish).not.toBeNull();
    expect(detail?.versions.length).toBe(2);
  });

  it("getContentDetail: draft (未公開) は activePublish が null", async () => {
    const detail = await withTenantContext(db, ctxA(), (tx) => getContentDetail(tx, contentA), APP);
    expect(detail?.content.status).toBe("draft");
    expect(detail?.activePublish).toBeNull();
    expect(detail?.versions).toEqual([]);
  });

  it("getContentDetail: unpublish 後は activePublish が null に戻る", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    await withTenantContext(db, ctxA(), (tx) => unpublishContent(tx, actorA(), contentA), APP);
    const detail = await withTenantContext(db, ctxA(), (tx) => getContentDetail(tx, contentA), APP);
    expect(detail?.content.status).toBe("archived");
    expect(detail?.activePublish).toBeNull();
  });

  it("getContentDetail: 不存在 id は null", async () => {
    const detail = await withTenantContext(
      db,
      ctxA(),
      (tx) => getContentDetail(tx, "00000000-0000-4000-8000-000000000000"),
      APP,
    );
    expect(detail).toBeNull();
  });

  it("listContents: 自校コンテンツを更新が新しい順に返す", async () => {
    const second = await seedDraft("文化祭のお知らせ");
    // contentA を更新して updatedAt を進める → 一覧先頭に来るはず
    await withTenantContext(
      db,
      ctxA(),
      (tx) => updateContent(tx, actorA(), contentA, { body: "更新" }),
      APP,
    );
    const list = await withTenantContext(db, ctxA(), (tx) => listContents(tx), APP);
    const ids = list.map((c) => c.id);
    expect(ids).toContain(contentA);
    expect(ids).toContain(second);
    expect(ids[0]).toBe(contentA); // 直近更新が先頭
  });

  it("listContents: status フィルタで published のみ返す", async () => {
    await seedDraft("下書きのまま"); // draft
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    const published = await withTenantContext(
      db,
      ctxA(),
      (tx) => listContents(tx, { status: "published" }),
      APP,
    );
    expect(published.map((c) => c.id)).toEqual([contentA]);
  });

  it("テナント分離: 別校 (B) からは A の詳細が null、一覧にも出ない (RLS)", async () => {
    await withTenantContext(db, ctxA(), (tx) => publishContent(tx, actorA(), contentA), APP);
    const ctxB = { userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const };
    const detail = await withTenantContext(db, ctxB, (tx) => getContentDetail(tx, contentA), APP);
    expect(detail).toBeNull();
    const list = await withTenantContext(db, ctxB, (tx) => listContents(tx), APP);
    expect(list.map((c) => c.id)).not.toContain(contentA);
  });

  it("空コンテキストは deny-by-default で一覧 0 件", async () => {
    const list = await withTenantContext(db, {}, (tx) => listContents(tx), APP);
    expect(list.length).toBe(0);
  });
});
