import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getClassSignageUrls } from "../../src/queries/tv-devices.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * エディタ着地「実画面モニタの壁」が読む `getClassSignageUrls`（自校の全クラス分まとめ取得）の RLS テナント
 * 分離 + 選定ロジックを検証する。`getClassSignageUrl`（単一クラス）のバッチ版で、壁の 2 判断（学科にモニタが
 * 紐づくか / 端末別パターン）の単一ソース。
 *
 * - 自校: `signage_url` 非 null・未削除のクラスのみキーに含み、各クラスは**最も新しく更新された 1 件**の URL
 *   （複数 TV の決定的選定。`getClassSignageUrl` と同規約）
 * - `signage_url` が null のデバイス / ソフトデリート済デバイスしか無いクラスはキーに**含めない**（モニタ未紐づけ扱い）
 * - TV 未設置クラスはキーに含めない
 * - 他校のクラスは RLS（tenant_isolation）で不可視 → 自校 Map に現れない（cross-tenant deny）
 *
 * 実 PG（DATABASE_URL）でのみ走り、未設定ならスキップ（ADR-012）。ドメイン関数は `appRole: 'kimiterrace_app'`
 * で test superuser を降格させ **RLS を実際に効かせる**。`sql`（BYPASSRLS）はシード/検証専用。UUID は他テストと
 * 衝突しない `c1a66-` / `519a9f-` 系を使う（共有 DB での衝突回避）。
 */
describeOrSkip("RLS: getClassSignageUrls（自校の全クラス→公開サイネージ URL）", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { sql: dbSql, db } = createDbClient(url!);
  const APP = { appRole: "kimiterrace_app" } as const;
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  // クラス（他テストと重ならない c1a66- 系）。
  const CLASS_A1 = "c1a66a00-0000-4000-8000-0000000000a1"; // TV あり（最新 + 旧）
  const CLASS_A2 = "c1a66a00-0000-4000-8000-0000000000a2"; // url=null のみ → モニタ未紐づけ扱い
  const CLASS_A3 = "c1a66a00-0000-4000-8000-0000000000a3"; // TV 未設置
  const CLASS_B1 = "c1a66b00-0000-4000-8000-0000000000b1"; // B 校
  // TV デバイス（519a9f- 系）。
  const DEV_A1_NEW = "519a9f00-0000-4000-8000-0000000000a1";
  const DEV_A1_OLD = "519a9f00-0000-4000-8000-0000000000a2";
  const DEV_A2_NULL = "519a9f00-0000-4000-8000-0000000000a3";
  const DEV_A1_DEL = "519a9f00-0000-4000-8000-0000000000a4";
  const DEV_B1 = "519a9f00-0000-4000-8000-0000000000b1";

  const URL_A1_NEW = "https://app.school-signage.net/signage/tokA1-new?design=pattern2";
  const URL_A1_OLD = "https://app.school-signage.net/signage/tokA1-old";
  const URL_B1 = "https://app.school-signage.net/signage/tokB1";

  // 「その他」トークン解決: CLASS_A4 は class_id 列バインドの端末を持たないが、有効な signage magic link を持ち、
  // その token を signage_url に載せた端末（class_id=NULL）が在る。class_id 列に依存せずトークンで紐付けを解決する検証。
  const CLASS_A4 = "c1a66a00-0000-4000-8000-0000000000a4";
  const DEV_A4_TOK = "519a9f00-0000-4000-8000-0000000000a5";
  const TOK_A4 = "tokA4-resolve-via-magic-link";
  const URL_A4_TOK = `https://app.school-signage.net/signage/${TOK_A4}?design=pattern4`;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    await sql`
      INSERT INTO classes (id, school_id, name, grade) VALUES
        (${CLASS_A1}, ${fx.schoolA}, '電子工学科2年A', 2),
        (${CLASS_A2}, ${fx.schoolA}, '電子工学科2年B', 2),
        (${CLASS_A3}, ${fx.schoolA}, '電子工学科2年C', 2),
        (${CLASS_B1}, ${fx.schoolB}, '機械工学科2年A', 2)
    `;
    // CLASS_A1: 最新(非null・pattern2) / 旧(非null) / 最新だが削除済 → 最新の非null未削除 = URL_A1_NEW。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, deleted_at, updated_at) VALUES
        (${fx.schoolA}, ${DEV_A1_NEW}, ${CLASS_A1}, '新', ${URL_A1_NEW}, NULL,  now() - make_interval(days => 1::int)),
        (${fx.schoolA}, ${DEV_A1_OLD}, ${CLASS_A1}, '旧', ${URL_A1_OLD}, NULL,  now() - make_interval(days => 3::int)),
        (${fx.schoolA}, ${DEV_A1_DEL}, ${CLASS_A1}, '退役', ${URL_A1_NEW}, now(), now())
    `;
    // CLASS_A2: url=null のデバイスのみ → モニタ未紐づけ扱い（Map に現れない）。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, updated_at) VALUES
        (${fx.schoolA}, ${DEV_A2_NULL}, ${CLASS_A2}, 'URL無', NULL, now())
    `;
    // CLASS_B1（B 校）に 1 台（cross-tenant deny が vacuous でないことの実在保証）。
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, updated_at) VALUES
        (${fx.schoolB}, ${DEV_B1}, ${CLASS_B1}, 'B校', ${URL_B1}, now())
    `;
    // CLASS_A4: class_id 列バインド無し・signage_url のトークンで紐づく端末（class_id=NULL）。トークン解決で Map に入る。
    await sql`
      INSERT INTO classes (id, school_id, name, grade) VALUES
        (${CLASS_A4}, ${fx.schoolA}, '進路指導室前', 3)
    `;
    await sql`
      INSERT INTO magic_links (school_id, class_id, token_hash, token, expires_at) VALUES
        (${fx.schoolA}, ${CLASS_A4}, 'hash-tokA4-resolve', ${TOK_A4}, now() + make_interval(days => 365::int))
    `;
    await sql`
      INSERT INTO tv_devices (school_id, device_id, class_id, label, signage_url, updated_at) VALUES
        (${fx.schoolA}, ${DEV_A4_TOK}, NULL, '進路指導室前', ${URL_A4_TOK}, now())
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await dbSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  it("自校: signage_url を持つクラスのみ、最新の非null未削除 URL を返す（null/削除/未設置は除外）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolA, role: "teacher", userId: fx.userA },
      (tx) => getClassSignageUrls(tx),
      APP,
    );
    // CLASS_A1 は最新の非null未削除（pattern2 入り）が代表。
    expect(got.get(CLASS_A1)).toBe(URL_A1_NEW);
    // CLASS_A2（url=null のみ）/ CLASS_A3（未設置）はキーに現れない。
    expect(got.has(CLASS_A2)).toBe(false);
    expect(got.has(CLASS_A3)).toBe(false);
    // CLASS_A4: class_id 列バインド無しでも signage_url のトークンで紐づく端末を解決して Map に入る（その他モニタ是正）。
    expect(got.get(CLASS_A4)).toBe(URL_A4_TOK);
    // 他校クラスは RLS で不可視。
    expect(got.has(CLASS_B1)).toBe(false);
  });

  it("他校 context では他校クラスが見え、A 校クラスは見えない（cross-tenant deny が RLS 由来）", async () => {
    const got = await withTenantContext(
      db,
      { schoolId: fx.schoolB, role: "teacher", userId: fx.userB },
      (tx) => getClassSignageUrls(tx),
      APP,
    );
    expect(got.get(CLASS_B1)).toBe(URL_B1);
    expect(got.has(CLASS_A1)).toBe(false);
    // A 校のトークン紐付け（CLASS_A4）も他校 context からは RLS 不可視。
    expect(got.has(CLASS_A4)).toBe(false);
  });
});
