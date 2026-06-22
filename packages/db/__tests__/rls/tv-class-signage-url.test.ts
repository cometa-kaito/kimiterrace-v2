import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getClassSignageUrl } from "../../src/queries/tv-devices.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * クラスエディタ「このクラスのサイネージを開く」導線が読む `getClassSignageUrl` の RLS テナント分離 +
 * 選定ロジックを検証する。
 *
 * - 自校クラス: `signage_url` 非 null・未削除のうち **最も新しく更新された 1 件**を返す（複数 TV の決定的選定）
 * - `signage_url` が null のデバイス / ソフトデリート済デバイスは対象外（最新でも返さない）
 * - TV 未設置クラスは `undefined`（呼び出し側はリンクを出さない＝死リンク防止）
 * - 他校クラスの URL は RLS（tenant_isolation）で不可視 → `undefined`（cross-tenant deny、token 漏洩防止）
 * - teacher（EDITOR_ROLES = 実際の呼び出しロール）で自校が読めることも確認
 *
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。ドメイン関数は `appRole:
 * 'kimiterrace_app'` で test superuser を降格させ **RLS を実際に効かせる**。`sql`（BYPASSRLS）はシード/
 * 検証専用。UUID は他テストと衝突しない `c1a55-` / `519a9e-` 系を使う（共有 DB での衝突回避）。
 */
describeOrSkip("RLS: getClassSignageUrl（クラス→公開サイネージ URL）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // クラス（他テストと重ならない c1a55- 系）。
  const CLASS_A = "c1a55a00-0000-4000-8000-0000000000a1";
  const CLASS_A_NOTV = "c1a55a00-0000-4000-8000-0000000000a2";
  const CLASS_B = "c1a55b00-0000-4000-8000-0000000000b1";
  // TV デバイス（519a9e- 系 = signage url）。
  const DEV_A_NEW = "519a9e00-0000-4000-8000-0000000000a1";
  const DEV_A_OLD = "519a9e00-0000-4000-8000-0000000000a2";
  const DEV_A_NULL = "519a9e00-0000-4000-8000-0000000000a3";
  const DEV_A_DEL = "519a9e00-0000-4000-8000-0000000000a4";
  const DEV_B = "519a9e00-0000-4000-8000-0000000000b1";

  const URL_A_NEW = "https://app.school-signage.net/signage/tokA-new?design=pattern2";
  const URL_A_OLD = "https://app.school-signage.net/signage/tokA-old";
  const URL_B = "https://app.school-signage.net/signage/tokB";

  // 「その他」モニタの実態: class_id 列は未設定だが signage_url の magic link トークンでクラスに紐づく端末
  // （手貼り URL 等で class_id 列が NULL のまま。実機はトークンで解決して表示する）。トークン解決フォールバックの検証用。
  const CLASS_A_TOK = "c1a55a00-0000-4000-8000-0000000000a3"; // class_id 列バインド無し・トークンのみで紐付け
  const DEV_A_TOK = "519a9e00-0000-4000-8000-0000000000a5"; // class_id NULL・signage_url のトークンが CLASS_A_TOK を指す
  const TOK_A_RESOLVE = "tokA-resolve-via-magic-link";
  const URL_A_TOK = `https://app.school-signage.net/signage/${TOK_A_RESOLVE}?design=pattern4`;

  // 期限切れ magic link のトークン紐付け（実機 resolve_magic_link は期限切れを解決しない＝エディタも解決しないべき）。
  const CLASS_A_EXP = "c1a55a00-0000-4000-8000-0000000000a4"; // 期限切れリンク + token-only 端末
  const DEV_A_EXP = "519a9e00-0000-4000-8000-0000000000a6";
  const TOK_A_EXP = "tokA-expired-link";
  const URL_A_EXP = `https://app.school-signage.net/signage/${TOK_A_EXP}?design=pattern4`;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // クラスを 3 つ seed（A 校に 2: TV あり / TV なし、B 校に 1）。BYPASSRLS = テーブル所有者接続。
    await sql`
      INSERT INTO classes (id, school_id, name, grade) VALUES
        (${CLASS_A}, ${fx.schoolA}, '電子工学科1年A', 1),
        (${CLASS_A_NOTV}, ${fx.schoolA}, '電子工学科1年B', 1),
        (${CLASS_B}, ${fx.schoolB}, '機械工学科1年A', 1)
    `;
    // A 校 CLASS_A に 4 台: 最新(非null) / 旧(非null) / 最新だが null / 最新だが削除済。
    // updated_at は「最新優先」を検証するため DB 側 now()-make_interval で固定する。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, deleted_at, updated_at) VALUES
        (${fx.schoolA}, ${DEV_A_NEW},  ${CLASS_A}, '新',     ${URL_A_NEW}, NULL,   now() - make_interval(days => 1::int)),
        (${fx.schoolA}, ${DEV_A_OLD},  ${CLASS_A}, '旧',     ${URL_A_OLD}, NULL,   now() - make_interval(days => 3::int)),
        (${fx.schoolA}, ${DEV_A_NULL}, ${CLASS_A}, 'URL無',  NULL,         NULL,   now()),
        (${fx.schoolA}, ${DEV_A_DEL},  ${CLASS_A}, '退役',   ${URL_A_NEW}, now(),  now())
    `;
    // B 校 CLASS_B に 1 台（cross-tenant deny が vacuous でないことの実在保証）。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, updated_at) VALUES
        (${fx.schoolB}, ${DEV_B}, ${CLASS_B}, 'B校', ${URL_B}, now())
    `;
    // 「その他」トークン解決シナリオ: CLASS_A_TOK は class_id 列バインドの端末を持たないが、有効な signage
    // magic link（平文 token + token_hash）を持ち、その token を signage_url に載せた端末（class_id=NULL）が在る。
    await sql`
      INSERT INTO classes (id, school_id, name, grade) VALUES
        (${CLASS_A_TOK}, ${fx.schoolA}, '進路指導室前', 3)
    `;
    await sql`
      INSERT INTO magic_links (school_id, class_id, token_hash, token, expires_at) VALUES
        (${fx.schoolA}, ${CLASS_A_TOK}, 'hash-tokA-resolve', ${TOK_A_RESOLVE}, now() + make_interval(days => 365::int))
    `;
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, updated_at) VALUES
        (${fx.schoolA}, ${DEV_A_TOK}, NULL, '進路指導室前', ${URL_A_TOK}, now())
    `;
    // 期限切れシナリオ: CLASS_A_EXP は token-only 端末を持つが magic link が期限切れ → 解決されないべき。
    await sql`
      INSERT INTO classes (id, school_id, name, grade) VALUES
        (${CLASS_A_EXP}, ${fx.schoolA}, '職員室前', 3)
    `;
    await sql`
      INSERT INTO magic_links (school_id, class_id, token_hash, token, expires_at) VALUES
        (${fx.schoolA}, ${CLASS_A_EXP}, 'hash-tokA-expired', ${TOK_A_EXP}, now() - make_interval(days => 1::int))
    `;
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, updated_at) VALUES
        (${fx.schoolA}, ${DEV_A_EXP}, NULL, '職員室前', ${URL_A_EXP}, now())
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("自校クラス: 非 null・未削除のうち最も新しく更新された URL を返す（teacher）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getClassSignageUrl(tx, CLASS_A),
      APP,
    );
    // DEV_A_NEW(1日前・非null) が選ばれる。DEV_A_OLD(3日前) より新しく、
    // DEV_A_NULL(最新だが url=null) と DEV_A_DEL(最新だが削除済) は除外される。
    expect(got).toBe(URL_A_NEW);
  });

  it("TV 未設置クラスは undefined（死リンク防止）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getClassSignageUrl(tx, CLASS_A_NOTV),
      APP,
    );
    expect(got).toBeUndefined();
  });

  it("他校クラスの URL は RLS で不可視 → undefined（cross-tenant deny / token 漏洩防止）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getClassSignageUrl(tx, CLASS_B),
      APP,
    );
    expect(got).toBeUndefined();

    // B 校 context なら自校クラスとして見える（deny が「行が無いから」ではなく RLS 由来であることを担保）。
    const own = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "teacher", userId: fx.userB },
      (tx) => getClassSignageUrl(tx, CLASS_B),
      APP,
    );
    expect(own).toBe(URL_B);
  });

  it("class_id 列が未設定でも signage_url のトークンで紐づくクラスを解決して URL を返す（その他モニタの是正）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getClassSignageUrl(tx, CLASS_A_TOK),
      APP,
    );
    // class_id 列バインドの端末は無いが、DEV_A_TOK の signage_url のトークンが当該クラスの magic link に一致 → 解決。
    expect(got).toBe(URL_A_TOK);
  });

  it("期限切れ magic link のトークン紐付けは解決しない（実機 resolve_magic_link と同じ有効性判定）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getClassSignageUrl(tx, CLASS_A_EXP),
      APP,
    );
    // 期限切れ（revoked ではないが expires_at < now()）リンクは実機でも 410 → エディタも解決しない。
    expect(got).toBeUndefined();
  });

  it("トークン解決は RLS テナント分離を保つ（他校 context から A 校のトークン紐付けは不可視）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "teacher", userId: fx.userB },
      (tx) => getClassSignageUrl(tx, CLASS_A_TOK),
      APP,
    );
    // 他校 context では A 校の magic_links / tv_devices が RLS 不可視 → 解決できない。
    expect(got).toBeUndefined();
  });

  it("サニティ: BYPASSRLS では B 校デバイスが実在する（cross-tenant deny が vacuous でない）", async () => {
    const all = await sql<{ signage_url: string | null }[]>`
      SELECT signage_url FROM tv_devices WHERE device_id = ${DEV_B}
    `;
    expect(all.length).toBe(1);
    expect(all[0].signage_url).toBe(URL_B);
  });
});
