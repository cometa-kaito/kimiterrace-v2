import { afterAll, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { getConnectionUrl } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * E-01 / SEC-024: SET LOCAL ROLE 識別子インジェクションの敵対監査。
 *
 * Drizzle ORM の parameter binding により、本リポジトリの値ベース SQLi 面は構造的に閉じている
 * (値はすべて sql`...${v}...` で自動バインドされ、文字列連結されない)。唯一パラメータ化**できない**のが
 * `SET LOCAL ROLE ${appRole}` (src/client.ts) — ロール名は SQL 識別子でバインド不能なため
 * sql.raw で文字列補間される。ここだけは `SAFE_ROLE_NAME` allowlist (/^[A-Za-z_][A-Za-z0-9_]*$/) が
 * 唯一の防御線になる。allowlist が緩和/削除されると、SET LOCAL ROLE 経由の任意ロール昇格
 * (= RLS バイパス、CLAUDE.md ルール2 破壊) を招く。
 *
 * 本スイートは withTenantContext の appRole ガードを攻撃者視点で網羅し、injection ペイロード
 * (`; DROP` / `--` / 引用符 / スペース / 改行 / ドット / 非ASCII / コメント等) が **transaction 開始前に
 * `不正な appRole` で throw** され SQL に一切到達しないことを実 PG で固定する。エラーメッセージが
 * ガード由来であることで「injection が SET LOCAL ROLE に組み込まれず弾かれた」ことを示す。
 *
 * 末尾に「正規 role 名なら実際に SET LOCAL ROLE が成功する」対比を置き、全 throw になる
 * vacuous テストでないことを保証する。実 PG (kimiterrace_app ロール) が要るため DATABASE_URL
 * 未設定ではスキップ (CI Test job で実走)。
 */

const VALID_SCHOOL = "22222222-2222-4222-8222-222222222222";

describeOrSkip("E-01 / SEC-024: SET LOCAL ROLE 識別子インジェクション (appRole allowlist)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const { db, sql } = createDbClient(url!);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // SET LOCAL ROLE への識別子インジェクションを狙う敵対ペイロード集。
  // いずれも SAFE_ROLE_NAME に不一致 → withTenantContext が transaction 前に throw すべき。
  const injections = [
    "kimiterrace_app; DROP TABLE users",
    "kimiterrace_app; RESET ROLE",
    "kimiterrace_app--",
    "kimiterrace_app'",
    'kimiterrace_app"',
    "; SET ROLE postgres",
    "postgres; SELECT 1",
    "kimiterrace app",
    "kimiterrace_app\n",
    "kimiterrace_app\t",
    "1role",
    "role-name",
    "role.name",
    "role$x",
    "",
    "ロール",
    "app/*c*/",
  ];
  for (const appRole of injections) {
    it(`injection appRole=${JSON.stringify(appRole)} → 不正な appRole で throw (SQL 未到達)`, async () => {
      await expect(
        withTenantContext(db, { schoolId: VALID_SCHOOL, role: "school_admin" }, async () => "ok", {
          appRole,
        }),
      ).rejects.toThrow(/不正な appRole/);
    });
  }

  it("正規 appRole=kimiterrace_app → 実際に SET LOCAL ROLE が成功 (allowlist 通過、vacuous でない対比)", async () => {
    // 実 PG で SET LOCAL ROLE kimiterrace_app が成功しないと throw する。resolves で成功を示す。
    await expect(
      withTenantContext(db, { schoolId: VALID_SCHOOL, role: "school_admin" }, async () => "ok", {
        appRole: "kimiterrace_app",
      }),
    ).resolves.toBe("ok");
  });
});
