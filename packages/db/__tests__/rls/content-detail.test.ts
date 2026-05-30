import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import {
  getContentConfidence,
  getContentDetail,
  listContents,
} from "../../src/queries/content-detail.js";
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
    await raw`DELETE FROM ai_extractions`;
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

    // M1 (Reviewer): read 層は RLS 依拠なので、B コンテキストでは A の content_versions /
    // publishes 行も直接クエリで 0 件であることを実証する (detail=null の early-return だけでなく、
    // 下層テーブルの越境漏れが無いことを本ファイルでも固定する)。
    const leak = await withTenantContext(
      db,
      ctxB,
      async (tx) => {
        const vers = await tx.execute(
          sql`SELECT count(*)::int AS n FROM content_versions WHERE content_id = ${contentA}`,
        );
        const pubs = await tx.execute(
          sql`SELECT count(*)::int AS n FROM publishes WHERE content_id = ${contentA}`,
        );
        return {
          versions: (vers[0] as { n: number }).n,
          publishes: (pubs[0] as { n: number }).n,
        };
      },
      APP,
    );
    expect(leak).toEqual({ versions: 0, publishes: 0 });
  });

  it("空コンテキストは deny-by-default で一覧 0 件", async () => {
    const list = await withTenantContext(db, {}, (tx) => listContents(tx), APP);
    expect(list.length).toBe(0);
  });

  // --- F04.3 getContentConfidence ---

  async function seedExtraction(
    contentId: string,
    score: number,
    evidence: unknown,
  ): Promise<void> {
    await raw`
      INSERT INTO ai_extractions
        (school_id, content_id, extraction_kind, confidence_score, evidence, model_version, created_by)
      VALUES
        (${fx.schoolA}, ${contentId}, 'summary', ${score}, ${raw.json(evidence as never)},
         'gemini-test', ${fx.userA})
    `;
  }

  it("getContentConfidence: 複数抽出のうち最小 confidence + 根拠を返す (最も慎重に倒す)", async () => {
    await seedExtraction(contentA, 0.95, [{ text: "高確信の根拠" }]);
    await seedExtraction(contentA, 0.55, [{ text: "弱い根拠1" }, { text: "弱い根拠2" }]);
    const conf = await withTenantContext(
      db,
      ctxA(),
      (tx) => getContentConfidence(tx, contentA),
      APP,
    );
    expect(conf?.score).toBeCloseTo(0.55, 5);
    expect(conf?.evidence).toBe("弱い根拠1 / 弱い根拠2");
  });

  it("getContentConfidence: 抽出が無ければ null (人手作成 → フラグ出さない)", async () => {
    const conf = await withTenantContext(
      db,
      ctxA(),
      (tx) => getContentConfidence(tx, contentA),
      APP,
    );
    expect(conf).toBeNull();
  });

  it("getContentConfidence: evidence が空配列なら evidence は null (score は返す)", async () => {
    await seedExtraction(contentA, 0.4, []);
    const conf = await withTenantContext(
      db,
      ctxA(),
      (tx) => getContentConfidence(tx, contentA),
      APP,
    );
    expect(conf?.score).toBeCloseTo(0.4, 5);
    expect(conf?.evidence).toBeNull();
  });

  it("テナント分離: 別校 (B) からは A の抽出 confidence が見えず null (RLS)", async () => {
    await seedExtraction(contentA, 0.3, [{ text: "A の根拠" }]);
    const ctxB = { userId: fx.userB, schoolId: fx.schoolB, role: "teacher" as const };
    const conf = await withTenantContext(db, ctxB, (tx) => getContentConfidence(tx, contentA), APP);
    expect(conf).toBeNull();
  });
});
