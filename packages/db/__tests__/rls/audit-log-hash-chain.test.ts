import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * NFR04 hash chain 検証。
 *
 * `0003_audit_trigger.sql` の `audit_log_hash_chain` トリガが:
 *   - 先頭行は `prev_hash = NULL`、`row_hash = SHA-256(... payload ...)`
 *   - 後続行は `prev_hash = 直前行の row_hash`、`row_hash` も payload に prev_hash を含む
 * を満たし、`audit_log_verify_chain()` が空配列 (= 整合) を返すことを検証する。
 *
 * また、超管理者経由で row_hash を改竄した場合、verify が不整合を検出することも確認する
 * (改竄は trigger DISABLE 経由でしか起こせない = 攻撃難度が極めて高いことの裏返し)。
 */
describeOrSkip("audit_log: hash chain integrity", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function insertN(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO audit_log (
          school_id, actor_user_id, table_name, record_id, operation, diff
        ) VALUES (
          ${fx.schoolA},
          ${fx.userA},
          'contents',
          ${fx.schoolA},
          'insert',
          ${sql.json({ seq: i })}
        )
        RETURNING id
      `;
      ids.push(row.id);
    }
    return ids;
  }

  it("先頭行は prev_hash = NULL、後続行は直前行の row_hash を引き継ぐ", async () => {
    const ids = await insertN(3);
    const rows = await sql<{ id: string; prev_hash: string | null; row_hash: string }[]>`
      SELECT id, prev_hash, row_hash
        FROM audit_log
       WHERE id = ANY(${sql.array(ids)}::uuid[])
       ORDER BY occurred_at ASC, id ASC
    `;
    expect(rows[0].prev_hash).toBeNull();
    expect(rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].row_hash);
      expect(rows[i].row_hash).toMatch(/^[0-9a-f]{64}$/);
      // 連続行で row_hash が等しいことは無い (payload に seq / occurred_at が含まれるため)
      expect(rows[i].row_hash).not.toBe(rows[i - 1].row_hash);
    }
  });

  it("audit_log_verify_chain() は整合状態で空配列を返す", async () => {
    await insertN(2);
    const broken = await sql<{ broken_id: string }[]>`
      SELECT broken_id FROM audit_log_verify_chain()
    `;
    expect(broken.length).toBe(0);
  });

  it("trigger 一時 DISABLE + 改竄 + 再 ENABLE すると verify が不整合を検出する", async () => {
    const [target, ...rest] = await insertN(2);
    expect(rest.length).toBe(1);

    // 攻撃シミュレーション: トリガを止めて diff を改竄 (実環境では superuser のみ可能)
    await sql.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;");
    try {
      await sql`UPDATE audit_log SET diff = ${sql.json({ tampered: true })} WHERE id = ${target}`;
    } finally {
      await sql.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;");
    }

    const broken = await sql<{ broken_id: string }[]>`
      SELECT broken_id FROM audit_log_verify_chain()
    `;
    // 改竄行は row_hash が再計算結果と乖離し、以降の行も prev_hash 不一致で破綻する
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.some((b) => b.broken_id === target)).toBe(true);
  });

  it("INSERT で prev_hash / row_hash を入力しても trigger が上書きする (改竄入力対策)", async () => {
    const [row] = await sql<{ prev_hash: string | null; row_hash: string }[]>`
      INSERT INTO audit_log (
        school_id, actor_user_id, table_name, record_id, operation, diff,
        prev_hash, row_hash
      ) VALUES (
        ${fx.schoolA}, ${fx.userA}, 'contents', ${fx.schoolA}, 'insert',
        ${sql.json({ x: 1 })},
        'CLIENT_SUPPLIED_FAKE_PREV',
        'CLIENT_SUPPLIED_FAKE_ROW'
      )
      RETURNING prev_hash, row_hash
    `;
    expect(row.prev_hash).not.toBe("CLIENT_SUPPLIED_FAKE_PREV");
    expect(row.row_hash).not.toBe("CLIENT_SUPPLIED_FAKE_ROW");
    expect(row.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
