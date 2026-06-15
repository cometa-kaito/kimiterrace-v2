import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

/**
 * ai_chat_sessions / ai_chat_messages の RLS テナント分離 (read/deny matrix) テスト
 * (ルール2 穴埋め、Refs #59、脅威 I-01)。
 *
 * これらは F06 生徒 Q&A の **会話ログ** で、`ai_chat_messages.content_text` は生徒の質問内容
 * (PII マスキング後とはいえ最も機微) を保持する。**他校の会話を読めないこと**が漏洩=サービス終了
 * リスクの核心。
 *
 * **既存テストとの差分 (非重複)**: `composite-fk-cross-tenant.test.ts` は BYPASSRLS 接続で
 * composite FK の write 整合 (テナント混在 row を作れない) を見る。本テストは **app ロール
 * (`SET LOCAL ROLE kimiterrace_app`) 経由の RLS read/deny matrix** — 自校のみ可視・他校不可視・
 * context 未設定で deny-by-default・WITH CHECK・UPDATE/DELETE silent 0-row・system_admin 横断 —
 * を実 PG で固定する。policy は `tenant_isolation` + `system_admin_full_access` (migration 0002)。
 *
 * DATABASE_URL 未設定ならローカルは skip、CI (実 PG16) で実行。
 */

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

describeOrSkip("RLS ai_chat_sessions / ai_chat_messages (テナント分離 read/deny)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let classA: string;
  let classB: string;
  let magicA: string;
  let magicB: string;
  let sessionA: string;
  let sessionB: string;

  // 他校 content の漏洩を確実に検出するための識別可能な質問内容。
  const SECRET_A = "Aの生徒質問_秘密AAA";
  const SECRET_B = "Bの生徒質問_秘密BBB";

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    const mkClass = async (school: string, name: string) =>
      (
        await sql<{ id: string }[]>`
          INSERT INTO classes (school_id, name, grade)
          VALUES (${school}, ${name}, 1) RETURNING id
        `
      )[0].id;
    const mkMagic = async (school: string, klass: string, hash: string) =>
      (
        await sql<{ id: string }[]>`
          INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
          VALUES (${school}, ${klass}, ${hash}, now() + interval '30 days') RETURNING id
        `
      )[0].id;
    const mkSession = async (school: string, magic: string, klass: string) =>
      (
        await sql<{ id: string }[]>`
          INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
          VALUES (${school}, ${magic}, ${klass}) RETURNING id
        `
      )[0].id;
    const mkMessage = async (school: string, session: string, text: string) =>
      sql`
        INSERT INTO ai_chat_messages (school_id, session_id, role, content_text)
        VALUES (${school}, ${session}, 'user', ${text})
      `;

    classA = await mkClass(fx.schoolA, "1-A");
    classB = await mkClass(fx.schoolB, "1-B");
    magicA = await mkMagic(fx.schoolA, classA, "aichat-rls-A");
    magicB = await mkMagic(fx.schoolB, classB, "aichat-rls-B");
    sessionA = await mkSession(fx.schoolA, magicA, classA);
    sessionB = await mkSession(fx.schoolB, magicB, classB);
    await mkMessage(fx.schoolA, sessionA, SECRET_A);
    await mkMessage(fx.schoolB, sessionB, SECRET_B);
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- ai_chat_sessions ---

  it("sessions: A context → 自校セッションのみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const rows = await tx<{ id: string; school_id: string }[]>`
        SELECT id, school_id FROM ai_chat_sessions
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].id).toBe(sessionA);
    });
  });

  it("sessions: B context → 自校セッションのみ可視 (A の session は見えない)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM ai_chat_sessions`;
      expect(rows.length).toBe(1);
      expect(rows[0].id).toBe(sessionB);
    });
  });

  it("sessions: context 未設定 → deny-by-default (0 件)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM ai_chat_sessions`;
      expect(rows.length).toBe(0);
    });
  });

  it("sessions: WITH CHECK 負 — A context で school_id=B の INSERT は RLS で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'student', true)`;
        // FK は (B,magicB)/(B,classB) で整合させ、唯一の失敗要因を RLS WITH CHECK に絞る。
        await tx`
          INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
          VALUES (${fx.schoolB}, ${magicB}, ${classB})
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("sessions: system_admin → 全校セッションが見える (cross-tenant)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const rows = await tx<{ id: string }[]>`SELECT id FROM ai_chat_sessions`;
      expect(rows.length).toBe(2);
    });
  });

  // --- ai_chat_messages (content_text = 機微) ---

  it("messages: A context → 自校メッセージのみ可視、他校 content_text は漏れない", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const rows = await tx<{ content_text: string }[]>`
        SELECT content_text FROM ai_chat_messages
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].content_text).toBe(SECRET_A);
      // 他校の質問内容が一切混ざらないこと (漏洩=サービス終了の核心)。
      expect(rows.map((r) => r.content_text)).not.toContain(SECRET_B);
    });
  });

  it("messages: B context → 自校メッセージのみ可視", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const rows = await tx<{ content_text: string }[]>`SELECT content_text FROM ai_chat_messages`;
      expect(rows.length).toBe(1);
      expect(rows[0].content_text).toBe(SECRET_B);
    });
  });

  it("messages: context 未設定 → deny-by-default (0 件)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM ai_chat_messages`;
      expect(rows.length).toBe(0);
    });
  });

  it("messages: WITH CHECK 負 — A context で school_id=B の INSERT は RLS で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'student', true)`;
        await tx`
          INSERT INTO ai_chat_messages (school_id, session_id, role, content_text)
          VALUES (${fx.schoolB}, ${sessionB}, 'user', 'forge')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("messages: UPDATE — A context で他校メッセージは更新不可 (silent 0-row)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const res = await tx`
        UPDATE ai_chat_messages SET content_text = 'hijack' WHERE school_id = ${fx.schoolB}
      `;
      expect(res.count).toBe(0);
    });
    // BYPASSRLS で B の content_text が不変であることを確認。
    const after = await sql<{ content_text: string }[]>`
      SELECT content_text FROM ai_chat_messages WHERE school_id = ${fx.schoolB}
    `;
    expect(after[0]?.content_text).toBe(SECRET_B);
  });

  it("messages: DELETE — A context で他校メッセージは削除不可 (silent 0-row)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'student', true)`;
      const res = await tx`DELETE FROM ai_chat_messages WHERE school_id = ${fx.schoolB}`;
      expect(res.count).toBe(0);
    });
    const remain = await sql<{ id: string }[]>`
      SELECT id FROM ai_chat_messages WHERE school_id = ${fx.schoolB}
    `;
    expect(remain.length).toBe(1);
  });
});
