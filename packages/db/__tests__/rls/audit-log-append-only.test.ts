/**
 * audit_log は append-only。
 *   - INSERT は通る
 *   - UPDATE は trigger でエラー (P0001 'audit_log is append-only')
 *   - DELETE も同様にエラー
 *
 * 関連: NFR04, ADR-019
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSharedPg, resetData } from "../_helpers/postgres.js";

describe("audit_log append-only enforcement", () => {
  afterAll(async () => {
    const pg = await getSharedPg();
    await pg.cleanup();
  });

  beforeEach(async () => {
    const pg = await getSharedPg();
    await resetData(pg);
  });

  async function insertOne(pg: Awaited<ReturnType<typeof getSharedPg>>): Promise<string> {
    const id = randomUUID();
    await pg.admin.unsafe(`
      INSERT INTO audit_log
        (id, table_name, operation, diff, row_hash)
      VALUES
        ('${id}', 'users', 'insert', '{"after":{"id":"u1"}}'::jsonb, 'placeholder');
    `);
    return id;
  }

  it("INSERT は通る (row_hash は trigger が上書き)", async () => {
    const pg = await getSharedPg();
    const id = await insertOne(pg);

    const rows = (await pg.admin.unsafe(
      `SELECT row_hash FROM audit_log WHERE id = '${id}'`,
    )) as Array<{ row_hash: string }>;

    expect(rows.length).toBe(1);
    // placeholder ではなく trigger 計算結果に上書きされている
    expect(rows[0]?.row_hash).not.toBe("placeholder");
    expect(rows[0]?.row_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("UPDATE は append-only trigger で拒否される", async () => {
    const pg = await getSharedPg();
    const id = await insertOne(pg);

    let error: Error | null = null;
    try {
      await pg.admin.unsafe(`UPDATE audit_log SET table_name = 'tampered' WHERE id = '${id}'`);
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/append-only/i);
  });

  it("DELETE は append-only trigger で拒否される", async () => {
    const pg = await getSharedPg();
    const id = await insertOne(pg);

    let error: Error | null = null;
    try {
      await pg.admin.unsafe(`DELETE FROM audit_log WHERE id = '${id}'`);
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/append-only/i);

    // 行は残っている
    const rows = (await pg.admin.unsafe(
      `SELECT id FROM audit_log WHERE id = '${id}'`,
    )) as unknown[];
    expect(rows.length).toBe(1);
  });
});
