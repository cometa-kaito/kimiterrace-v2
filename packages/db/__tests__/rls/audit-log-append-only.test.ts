import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * NFR04 + CLAUDE.md ルール 1: audit_log は append-only。
 *
 * `0003_audit_trigger.sql` の BEFORE UPDATE / DELETE / TRUNCATE トリガで
 * 物理的にブロックされることを検証する。
 *
 * - スーパーユーザー (BYPASSRLS) でも UPDATE/DELETE は弾かれる
 * - INSERT は許可される
 * - TRUNCATE も弾かれる (TRUNCATE は RLS の対象外なので独立して検証)
 */
describeOrSkip("audit_log: append-only enforcement", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  async function insertOne(): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO audit_log (
        school_id, actor_user_id, table_name, record_id, operation, diff
      ) VALUES (
        ${fx.schoolA}, ${fx.userA}, 'contents', ${fx.schoolA}, 'insert', ${sql.json({ a: 1 })}
      )
      RETURNING id
    `;
    return row.id;
  }

  it("INSERT は許可される", async () => {
    const id = await insertOne();
    expect(id).toBeTruthy();
  });

  it("UPDATE は BEFORE トリガで弾かれる (operation も diff も改竄不可)", async () => {
    const id = await insertOne();
    await expect(sql`UPDATE audit_log SET operation = 'delete' WHERE id = ${id}`).rejects.toThrow(
      /append-only|insufficient_privilege/i,
    );
    await expect(
      sql`UPDATE audit_log SET diff = ${sql.json({ tampered: true })} WHERE id = ${id}`,
    ).rejects.toThrow(/append-only|insufficient_privilege/i);
  });

  it("DELETE は BEFORE トリガで弾かれる", async () => {
    const id = await insertOne();
    await expect(sql`DELETE FROM audit_log WHERE id = ${id}`).rejects.toThrow(
      /append-only|insufficient_privilege/i,
    );
    // 行は残っている
    const rows = await sql`SELECT 1 FROM audit_log WHERE id = ${id}`;
    expect(rows.length).toBe(1);
  });

  it("TRUNCATE もブロックされる (RLS だけでは防げないため独立トリガで保護)", async () => {
    await expect(sql.unsafe("TRUNCATE audit_log")).rejects.toThrow(
      /append-only|insufficient_privilege/i,
    );
  });

  it("BYPASSRLS スーパーユーザーでも改竄不可 (RLS と独立に物理トリガで強制)", async () => {
    // 既に postgres スーパーユーザー (BYPASSRLS) で接続している前提。
    // それでも UPDATE/DELETE はトリガが先に走るためブロックされる。
    const id = await insertOne();
    await expect(sql`UPDATE audit_log SET row_hash = 'forged' WHERE id = ${id}`).rejects.toThrow(
      /append-only|insufficient_privilege/i,
    );
  });
});
