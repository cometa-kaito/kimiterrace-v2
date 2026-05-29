/**
 * audit_log の prev_hash / row_hash チェーン検証。
 *
 *   - 1 件目: prev_hash = NULL
 *   - 2 件目: prev_hash = 1 件目の row_hash
 *   - 3 件目: prev_hash = 2 件目の row_hash
 *   - row_hash は SHA-256 hex (64 文字)
 *   - row_hash の算出ロジック: encode(digest(prev_hash || actor_user_id || table_name ||
 *     record_id || operation || occurred_at || diff, 'sha256'), 'hex')
 *
 * クライアントが prev_hash / row_hash に任意値を入れても trigger が上書きする
 * （0004_audit_trigger.sql の audit_log_compute_hash）。
 *
 * 関連: NFR04
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPg, resetData } from "../_helpers/postgres.js";

const HASH_HEX_RE = /^[0-9a-f]{64}$/;

describe("audit_log hash chain", () => {
  afterAll(async () => {
    const pg = await getSharedPg();
    await pg.cleanup();
  });

  beforeEach(async () => {
    const pg = await getSharedPg();
    await resetData(pg);
  });

  it("先頭行は prev_hash = NULL、以降は直前行の row_hash と一致する", async () => {
    const pg = await getSharedPg();

    // 3 件を occurred_at の昇順で確実に並べるため、明示的に時刻を割り当てる
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 3; i++) {
      // 各行 1 秒ずつずらして並び順を確定
      await pg.admin.unsafe(`
        INSERT INTO audit_log (id, occurred_at, table_name, operation, diff, row_hash)
        VALUES (
          '${ids[i]}',
          (now() + interval '${i} seconds'),
          'users',
          'insert',
          '{"i":${i}}'::jsonb,
          'placeholder'
        );
      `);
    }

    const rows = (await pg.admin.unsafe(`
      SELECT id, prev_hash, row_hash
        FROM audit_log
       ORDER BY occurred_at ASC, id ASC
    `)) as Array<{ id: string; prev_hash: string | null; row_hash: string }>;

    expect(rows.length).toBe(3);

    // 1 件目: prev_hash = NULL
    expect(rows[0]?.prev_hash).toBeNull();
    expect(rows[0]?.row_hash).toMatch(HASH_HEX_RE);

    // 2 件目以降: prev_hash = 直前行の row_hash
    expect(rows[1]?.prev_hash).toBe(rows[0]?.row_hash);
    expect(rows[1]?.row_hash).toMatch(HASH_HEX_RE);
    expect(rows[2]?.prev_hash).toBe(rows[1]?.row_hash);
    expect(rows[2]?.row_hash).toMatch(HASH_HEX_RE);

    // 全 row_hash が一意 (collision なし)
    const hashes = new Set(rows.map((r) => r.row_hash));
    expect(hashes.size).toBe(3);
  });

  it("クライアントが渡した prev_hash / row_hash は trigger が上書きする", async () => {
    const pg = await getSharedPg();
    const id = randomUUID();

    await pg.admin.unsafe(`
      INSERT INTO audit_log
        (id, table_name, operation, diff, prev_hash, row_hash)
      VALUES
        ('${id}', 'users', 'insert', '{"x":1}'::jsonb, 'attacker_prev', 'attacker_row');
    `);

    const rows = (await pg.admin.unsafe(
      `SELECT prev_hash, row_hash FROM audit_log WHERE id = '${id}'`,
    )) as Array<{ prev_hash: string | null; row_hash: string }>;

    // 先頭行扱いなので prev_hash は NULL（攻撃者値は捨てられる）
    expect(rows[0]?.prev_hash).toBeNull();
    expect(rows[0]?.row_hash).not.toBe("attacker_row");
    expect(rows[0]?.row_hash).toMatch(HASH_HEX_RE);
  });

  it("row_hash は同入力に対し決定的 (re-INSERT した別行も同じ payload なら一致)", async () => {
    const pg = await getSharedPg();

    // 同じ payload を 2 行目以降に挿入しても、prev_hash が変わるため row_hash は変わる前提。
    // ここでは「先頭行に同じ入力を与えて 2 回試行 (resetData 挟む)」で決定性を確認する。
    async function insertHead(): Promise<string> {
      await resetData(pg);
      const id = "11111111-1111-1111-1111-111111111111";
      const actor = "22222222-2222-2222-2222-222222222222";
      // occurred_at は固定にして決定的にする
      await pg.admin.unsafe(`
        INSERT INTO audit_log
          (id, occurred_at, actor_user_id, table_name, record_id, operation, diff, row_hash)
        VALUES
          ('${id}',
           '2026-01-01 00:00:00+00',
           '${actor}',
           'users',
           '33333333-3333-3333-3333-333333333333',
           'insert',
           '{"after":{"name":"X"}}'::jsonb,
           'placeholder');
      `);
      const rows = (await pg.admin.unsafe(
        `SELECT row_hash FROM audit_log WHERE id = '${id}'`,
      )) as Array<{ row_hash: string }>;
      return rows[0]?.row_hash ?? "";
    }

    const hash1 = await insertHead();
    const hash2 = await insertHead();
    expect(hash1).toMatch(HASH_HEX_RE);
    expect(hash1).toBe(hash2);
  });
});
