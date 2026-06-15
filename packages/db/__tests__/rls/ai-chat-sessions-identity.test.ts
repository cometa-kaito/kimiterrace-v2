import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * ai_chat_sessions の **認証経路 XOR 整合** (`ck_ai_chat_sessions_identity`) + 教員経路セッションの
 * RLS テナント分離テスト (#370 F06 教員経路、ADR-028 / ADR-019)。
 *
 * #370 で ai_chat_sessions は 2 経路を 1 テーブルで表す:
 *  - 生徒(匿名): `magic_link_id` + `class_id` 非 null、`user_id` null
 *  - 教員(認証済): `user_id` 非 null、`magic_link_id` / `class_id` null（レート制限キーは user_id）
 *
 * XOR CHECK `(magic_link_id IS NOT NULL) <> (user_id IS NOT NULL)` が「両 null（経路欠落）」「両非
 * null（経路二重）」を DB レベルで弾くことと、**教員行も既存 RLS (tenant_isolation) で自校に閉じる**
 * ことを実 PG で固定する。
 *
 * **既存テストとの差分 (非重複)**: `ai-chat-tenant-isolation.test.ts` は生徒経路 (magic_link) の
 * read/deny matrix を見る。本テストは #370 で追加した **教員経路 (user_id) の挿入可否 + XOR 整合 +
 * 教員行のテナント分離** を対象にする。
 *
 * DATABASE_URL 未設定ならローカルは skip、CI (実 PG16) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("ai_chat_sessions 認証経路 XOR + 教員経路 RLS (#370)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let magicA: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 生徒経路の FK 充足用に school A のクラス + magic_link を用意する。
    classA = (
      await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, name, grade)
        VALUES (${fx.schoolA}, '1-A', 1) RETURNING id
      `
    )[0].id;
    magicA = (
      await sql<{ id: string }[]>`
        INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
        VALUES (${fx.schoolA}, ${classA}, 'identity-xor-A', now() + interval '30 days') RETURNING id
      `
    )[0].id;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
    // 各ケースを独立させるため、テスト間で作った session 行を掃除する (BYPASSRLS の seed ロール)。
    await sql`DELETE FROM ai_chat_sessions`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- 教員経路 (user_id) の挿入可否 ---

  it("教員行: A context で user_id 非 null・magic_link_id/class_id null は挿入できる", async () => {
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      const rows = await tx<{ id: string }[]>`
        INSERT INTO ai_chat_sessions (school_id, user_id)
        VALUES (${fx.schoolA}, ${fx.userA})
        RETURNING id
      `;
      return rows[0]?.id;
    });
    expect(id).toBeTruthy();
    // BYPASSRLS で形状を確認: magic_link_id/class_id は null、user_id は teacher。
    const [row] = await sql<
      { magic_link_id: string | null; class_id: string | null; user_id: string | null }[]
    >`
      SELECT magic_link_id, class_id, user_id FROM ai_chat_sessions WHERE id = ${id}
    `;
    expect(row.magic_link_id).toBeNull();
    expect(row.class_id).toBeNull();
    expect(row.user_id).toBe(fx.userA);
  });

  it("生徒行: magic_link_id/class_id 非 null・user_id null は引き続き挿入できる (回帰)", async () => {
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const rows = await tx<{ id: string }[]>`
        INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
        VALUES (${fx.schoolA}, ${magicA}, ${classA})
        RETURNING id
      `;
      return rows[0]?.id;
    });
    expect(id).toBeTruthy();
  });

  // --- XOR 整合 (ck_ai_chat_sessions_identity) ---

  it("XOR 負: 両方 null (magic_link_id も user_id も無し) は CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
        // school_id は context と一致させ、唯一の失敗要因を XOR CHECK に絞る。
        await tx`INSERT INTO ai_chat_sessions (school_id) VALUES (${fx.schoolA})`;
      }),
    ).rejects.toThrow(/ck_ai_chat_sessions_identity|check constraint/i);
  });

  it("XOR 負: 両方非 null (magic_link_id と user_id を同時指定) は CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
        // magic_link/class は (A) で整合、school_id も context 一致 → 失敗要因は XOR CHECK のみ。
        await tx`
          INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id, user_id)
          VALUES (${fx.schoolA}, ${magicA}, ${classA}, ${fx.userA})
        `;
      }),
    ).rejects.toThrow(/ck_ai_chat_sessions_identity|check constraint/i);
  });

  // --- 教員行のテナント分離 (RLS は新形状でも効く) ---

  it("教員行: B context からは A の教員セッションが見えない (tenant_isolation)", async () => {
    // A の教員セッションを 1 件作る (BYPASSRLS の seed ロールで直接 insert)。
    const [created] = await sql<{ id: string }[]>`
      INSERT INTO ai_chat_sessions (school_id, user_id)
      VALUES (${fx.schoolA}, ${fx.userA}) RETURNING id
    `;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM ai_chat_sessions`;
      expect(rows.map((r) => r.id)).not.toContain(created.id);
    });
    // A context では見える (vacuous でないことの担保)。
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM ai_chat_sessions`;
      expect(rows.map((r) => r.id)).toContain(created.id);
    });
  });
});
