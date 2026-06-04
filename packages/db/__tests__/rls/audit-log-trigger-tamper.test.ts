import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * R-02 / SEC-012: audit_log の append-only / hash-chain 保護を「アプリ用ロールが解除できない」
 * ことの敵対監査（既存 audit-log-append-only / hash-chain / actor-spoofing の拡張）。
 *
 * 既存スイートは **superuser で `ALTER TABLE ... DISABLE TRIGGER` してトリガを止める攻撃を
 * シミュレート**し、改竄が hash chain 検証で検出されることを示す。しかしそれは「superuser なら
 * できる」前提の話で、**本番で現実的な攻撃者＝乗っ取られた `kimiterrace_app`（非 superuser・
 * 非テーブル所有者）が、その DISABLE 自体に到達できないこと**は誰も固定していない。SEC-012 の
 * 防御成功条件「トリガ無効化は権限で不可」を、攻撃者ロール視点で能動的に網羅する:
 *
 *   1. `ALTER TABLE audit_log DISABLE TRIGGER ...`（4 本 + ALL）→ must be owner で拒否
 *   2. `DROP TRIGGER ... ON audit_log` → 拒否
 *   3. トリガ本体関数の `CREATE OR REPLACE FUNCTION`（無害化）→ 権限で拒否
 *   4. `SET LOCAL session_replication_role = 'replica'`（古典的トリガ迂回）→ superuser 専用で拒否
 *   5. `ALTER TABLE audit_log DROP COLUMN row_hash`（整合列の除去）→ 拒否
 *   6. `ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY`（cross-tenant 監査読取の解放）→ 拒否
 *
 * 正の対比（vacuous でないことの保証）: **同じ DISABLE を superuser は実行できる**（＝拒否は
 * 「SQL 不正」ではなく純粋に権限起因）。DDL はトランザクショナルなので sentinel で rollback し、
 * トリガを実際には無効化したまま残さない（rollback 後にトリガが enabled へ復元されることも確認）。
 *
 * 範囲正直: ここで固定するのは **DB 権限境界**（app ロールが改竄の起点に到達できない）まで。
 * 「superuser が triggers を止めて全行 hash を再計算する完全 re-forge」は、unkeyed な in-DB
 * hash chain だけでは検出できない（既存 hash-chain テストが検出するのは単一行改竄＝chain 破断の方）。
 * その層の防御＝KMS 署名チェックポイントの別 GCP プロジェクト独立検出は staging 運用項目（#243）で
 * あり packages/db のスコープ外。本テストは「app ロールが DISABLE/DROP/REPLACE/replica に
 * 到達できない」という**第一の砦**を固定する。
 *
 * 実 PG（kimiterrace_app ロール）が要るため DATABASE_URL 未設定ではスキップ（CI Test job で実走）。
 */
describeOrSkip("R-02 / SEC-012: audit_log トリガ改竄耐性 (app ロールは保護を解除できない)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // 権限拒否のメッセージ群（所有者要求 / パラメータ権限 / 一般権限）。SQL 不正や
  // 「trigger does not exist」ではなく権限起因で弾かれたことを示す。
  const PRIV = /must be owner|permission denied|insufficient privilege/i;

  /** kimiterrace_app ロールで 1 文を実行する（失敗すれば tx 全体が reject）。 */
  async function asApp(stmt: string): Promise<void> {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx.unsafe(stmt);
    });
  }

  // 改竄 DDL（いずれも audit_log の append-only / hash / RLS 保護を弱める操作）。
  const tamperAttempts: { name: string; stmt: string }[] = [
    {
      name: "DISABLE TRIGGER audit_log_no_update",
      stmt: "ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update",
    },
    {
      name: "DISABLE TRIGGER audit_log_no_delete",
      stmt: "ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete",
    },
    {
      name: "DISABLE TRIGGER audit_log_no_truncate",
      stmt: "ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate",
    },
    {
      name: "DISABLE TRIGGER audit_log_hash_chain",
      stmt: "ALTER TABLE audit_log DISABLE TRIGGER audit_log_hash_chain",
    },
    { name: "DISABLE TRIGGER ALL", stmt: "ALTER TABLE audit_log DISABLE TRIGGER ALL" },
    {
      name: "DROP TRIGGER audit_log_no_update",
      stmt: "DROP TRIGGER audit_log_no_update ON audit_log",
    },
    {
      name: "DROP TRIGGER audit_log_hash_chain",
      stmt: "DROP TRIGGER audit_log_hash_chain ON audit_log",
    },
    { name: "DROP COLUMN row_hash", stmt: "ALTER TABLE audit_log DROP COLUMN row_hash" },
    {
      name: "DISABLE ROW LEVEL SECURITY",
      stmt: "ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY",
    },
    {
      name: "neuter audit_log_set_hash() (hash 計算の無害化)",
      stmt: "CREATE OR REPLACE FUNCTION audit_log_set_hash() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$",
    },
    {
      name: "neuter audit_log_block_update_delete() (append-only の無害化)",
      stmt: "CREATE OR REPLACE FUNCTION audit_log_block_update_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END; $fn$",
    },
  ];

  for (const t of tamperAttempts) {
    it(`kimiterrace_app は「${t.name}」を実行できない (権限拒否)`, async () => {
      await expect(asApp(t.stmt)).rejects.toThrow(PRIV);
    });
  }

  it("kimiterrace_app は session_replication_role=replica を設定できない (古典的トリガ迂回が不能)", async () => {
    // session_replication_role='replica' は origin トリガ(tgenabled='O')を発火させない＝
    // append-only/hash トリガを丸ごと迂回できる古典手法。これは superuser 専用パラメータなので
    // 非 superuser の app ロールでは設定自体が permission denied で弾かれる。
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx.unsafe("SET LOCAL session_replication_role = 'replica'");
      }),
    ).rejects.toThrow(PRIV);
  });

  it("正の対比: superuser は DISABLE TRIGGER 可能 (拒否は権限起因) / rollback でトリガは復元される", async () => {
    // superuser では同じ DISABLE が通る = app ロールの拒否は「SQL 不正」でなく権限起因である証明。
    // DDL はトランザクショナル。sentinel で rollback し、無効化を commit せず元へ戻す。
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update");
        throw new Error("__contrast_rollback__");
      }),
    ).rejects.toThrow("__contrast_rollback__");

    // rollback 後、トリガは enabled に復元されている（'D' = disabled でない）。
    const [trg] = await sql<{ tgenabled: string }[]>`
      SELECT t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_log' AND t.tgname = 'audit_log_no_update'
    `;
    expect(trg.tgenabled).not.toBe("D");

    // 復元の実挙動確認: 既存行への UPDATE は依然ブロックされる（append-only 健在）。
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO audit_log (school_id, actor_user_id, table_name, record_id, operation, diff)
      VALUES (${fx.schoolA}, ${fx.userA}, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ restore: 1 })})
      RETURNING id
    `;
    await expect(
      sql`UPDATE audit_log SET operation = 'delete' WHERE id = ${row.id}`,
    ).rejects.toThrow(/append-only|insufficient_privilege/i);
  });

  it("保護トリガ 4 本が存在し有効 + kimiterrace_app は audit_log の所有者でない (拒否の設計姿勢)", async () => {
    const trigs = await sql<{ tgname: string; tgenabled: string }[]>`
      SELECT t.tgname, t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_log' AND NOT t.tgisinternal
      ORDER BY t.tgname
    `;
    const byName = new Map(trigs.map((r) => [r.tgname, r.tgenabled]));
    for (const name of [
      "audit_log_no_update",
      "audit_log_no_delete",
      "audit_log_no_truncate",
      "audit_log_hash_chain",
    ]) {
      expect(byName.has(name), `${name} が存在しない`).toBe(true);
      expect(byName.get(name), `${name} が無効化されている`).not.toBe("D");
    }
    // app ロールが所有者でないからこそ DISABLE/DROP/REPLACE が権限で拒否される。
    const [owner] = await sql<{ owner: string }[]>`
      SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.relname = 'audit_log'
    `;
    expect(owner.owner).not.toBe("kimiterrace_app");

    // 上記拒否の根幹前提: app ロールは SUPERUSER でも BYPASSRLS でもない。これが崩れると
    // 所有者チェックも RLS も迂回され、本スイートの全断言が静かに無意味化する（回帰の早期検知）。
    const [appRole] = await sql<{ super: boolean; bypassrls: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypassrls
        FROM pg_roles WHERE rolname = 'kimiterrace_app'
    `;
    expect(
      appRole.super,
      "kimiterrace_app が SUPERUSER（所有者チェックを迂回し改竄可能になる）",
    ).toBe(false);
    expect(
      appRole.bypassrls,
      "kimiterrace_app が BYPASSRLS（cross-tenant 監査読取が可能になる）",
    ).toBe(false);
  });
});
