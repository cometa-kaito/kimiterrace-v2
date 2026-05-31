import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #73 (PR #71 H-1): cross-tenant write 整合を DB 強制する composite FK の検証。
 *
 * RLS は read を守るが write のテナント混在は守らない。ここでは **owner 接続 (BYPASSRLS)** で
 * わざと school_id を食い違わせて INSERT し、composite FK が DB レベルで弾くことを確認する
 * (= RLS を完全にすり抜ける経路でもテナント混在 row を作れない、を保証する)。
 *
 * 接続は DATABASE_URL の superuser。SET ROLE しない = RLS をバイパスするため、FK だけが gate。
 */
describeOrSkip(
  "#73 composite FK cross-tenant write integrity (ai_chat_sessions / messages)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const sql = createSql(url!);
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
    let classA: string;
    let magicA: string;
    let magicB: string;
    let sessionA: string;

    beforeAll(async () => {
      fx = await seedBaseFixture(sql);
      classA = (
        await sql<{ id: string }[]>`
        INSERT INTO classes (school_id, academic_year, name, grade)
        VALUES (${fx.schoolA}, 2026, '1-A', 1) RETURNING id
      `
      )[0].id;
      magicA = (
        await sql<{ id: string }[]>`
        INSERT INTO magic_links (school_id, class_id, token_hash, expires_at)
        VALUES (${fx.schoolA}, ${classA}, 'cfk-hash-A', now() + interval '30 days') RETURNING id
      `
      )[0].id;
      magicB = (
        await sql<{ id: string }[]>`
        INSERT INTO magic_links (school_id, token_hash, expires_at)
        VALUES (${fx.schoolB}, 'cfk-hash-B', now() + interval '30 days') RETURNING id
      `
      )[0].id;
      // school A の正当なセッション (messages テスト用の親)
      sessionA = (
        await sql<{ id: string }[]>`
        INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
        VALUES (${fx.schoolA}, ${magicA}, ${classA}) RETURNING id
      `
      )[0].id;
    });

    beforeEach(async () => {
      await sql`RESET ROLE`;
    });

    afterAll(async () => {
      await sql.end({ timeout: 5 });
    });

    it("ai_chat_sessions: magic_link が別テナントだと composite FK 違反 (school 混在 write 不可)", async () => {
      // magic_link_id は school A の magicA だが school_id を school B にすり替える。
      await expect(
        sql`
        INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
        VALUES (${fx.schoolB}, ${magicA}, ${classA})
      `,
      ).rejects.toThrow(/fk_ai_chat_sessions_magic_link|violates foreign key/i);
    });

    it("ai_chat_sessions: class が別テナントだと composite FK 違反", async () => {
      // magic_link は school B (整合) だが class_id だけ school A の classA を指す。
      await expect(
        sql`
        INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
        VALUES (${fx.schoolB}, ${magicB}, ${classA})
      `,
      ).rejects.toThrow(/fk_ai_chat_sessions_class|violates foreign key/i);
    });

    it("ai_chat_messages: session が別テナントだと composite FK 違反", async () => {
      await expect(
        sql`
        INSERT INTO ai_chat_messages (school_id, session_id, role, content_text)
        VALUES (${fx.schoolB}, ${sessionA}, 'user', 'q')
      `,
      ).rejects.toThrow(/fk_ai_chat_messages_session|violates foreign key/i);
    });

    it("正常系: school_id が親と一致していれば session / message とも書ける", async () => {
      const [s] = await sql<{ id: string }[]>`
      INSERT INTO ai_chat_sessions (school_id, magic_link_id, class_id)
      VALUES (${fx.schoolA}, ${magicA}, ${classA}) RETURNING id
    `;
      expect(s.id).toBeTruthy();
      const [m] = await sql<{ id: string }[]>`
      INSERT INTO ai_chat_messages (school_id, session_id, role, content_text)
      VALUES (${fx.schoolA}, ${s.id}, 'user', 'q') RETURNING id
    `;
      expect(m.id).toBeTruthy();
    });

    it("親 UNIQUE(id, school_id) が composite FK の参照先として存在する", async () => {
      const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'uq_magic_links_id_school', 'uq_classes_id_school', 'uq_ai_chat_sessions_id_school'
      )
      ORDER BY conname
    `;
      expect(rows.map((r) => r.conname)).toEqual([
        "uq_ai_chat_sessions_id_school",
        "uq_classes_id_school",
        "uq_magic_links_id_school",
      ]);
    });
  },
);
