import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F02: teacher_inputs / teacher_input_attachments の RLS テナント分離を検証する。
 *
 * - tenant_isolation: 自校のみ可視 (許可ケース)、他テナントは不可視 (拒否ケース)
 * - context 未設定 → 全件拒否 (deny by default)
 * - 他テナント school_id での INSERT は WITH CHECK で拒否
 * - system_admin_full_access: cross-tenant で全件可視
 * - 添付メタ (teacher_input_attachments) も同じ分離挙動
 *
 * CLAUDE.md ルール2 (RLS は DB レベルで強制、許可/拒否 両ケースをテスト)。
 */
describeOrSkip("RLS: F02 teacher_inputs / teacher_input_attachments", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
  let inputA: string;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // 各校に teacher_input を 1 件ずつ (BYPASSRLS = テーブル所有者接続)
    const [a] = await sql<{ id: string }[]>`
      INSERT INTO teacher_inputs (school_id, teacher_id, input_type, status, transcript)
      VALUES (${fx.schoolA}, ${fx.userA}, 'chat', 'draft', 'A の下書き')
      RETURNING id
    `;
    inputA = a.id;
    await sql`
      INSERT INTO teacher_inputs (school_id, teacher_id, input_type, status, transcript)
      VALUES (${fx.schoolB}, ${fx.userB}, 'voice', 'ready', 'B の文字起こし')
    `;
    // 添付メタを school A に 1 件 (inputA に紐付け)
    await sql`
      INSERT INTO teacher_input_attachments (school_id, input_id, storage_path, mime_type)
      VALUES (${fx.schoolA}, ${inputA}, 'gs://bucket/a.pdf', 'application/pdf')
    `;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // ---------------------------------------------------------------------------
  // teacher_inputs: 許可ケース / 拒否ケース
  // ---------------------------------------------------------------------------

  it("school A context は A の入力のみ可視 (許可ケース)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;

      const rows = await tx<{ transcript: string; school_id: string }[]>`
        SELECT transcript, school_id FROM teacher_inputs
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].school_id).toBe(fx.schoolA);
      expect(rows[0].transcript).toBe("A の下書き");
    });
  });

  it("school B context は B の入力のみ可視 (別テナントは見えない = 拒否ケース)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;

      const rows = await tx<{ transcript: string }[]>`SELECT transcript FROM teacher_inputs`;
      expect(rows.length).toBe(1);
      expect(rows[0].transcript).toBe("B の文字起こし");
    });
  });

  it("context 未設定 → 全件拒否 (0 件、deny by default)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx<{ id: string }[]>`SELECT id FROM teacher_inputs`;
      expect(rows.length).toBe(0);
    });
  });

  it("他テナント school_id での INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
        await tx`
          INSERT INTO teacher_inputs (school_id, input_type, status)
          VALUES (${fx.schoolB}, 'chat', 'draft')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("他テナントの入力は UPDATE 不可 (silent 0-row)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;

      // A context から B の入力 (school_id=B) を直接 UPDATE しようとしても USING で 0-row
      const res = await tx`
        UPDATE teacher_inputs SET transcript = '改竄' WHERE school_id = ${fx.schoolB}
      `;
      expect(res.count).toBe(0);
    });
  });

  it("system_admin は cross-tenant で全入力が見える", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;

      const rows = await tx<{ id: string }[]>`SELECT id FROM teacher_inputs`;
      expect(rows.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // teacher_input_attachments: 許可ケース / 拒否ケース
  // ---------------------------------------------------------------------------

  it("添付メタ: school A context は A の添付のみ可視 (許可ケース)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;

      const rows = await tx<{ storage_path: string }[]>`
        SELECT storage_path FROM teacher_input_attachments
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].storage_path).toBe("gs://bucket/a.pdf");
    });
  });

  it("添付メタ: school B context は A の添付が見えない (拒否ケース)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolB}, true)`;
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;

      const rows = await tx<{ id: string }[]>`SELECT id FROM teacher_input_attachments`;
      expect(rows.length).toBe(0);
    });
  });

  it("添付メタ: 他テナント school_id での INSERT は WITH CHECK で拒否", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
        await tx`
          INSERT INTO teacher_input_attachments (school_id, input_id, storage_path, mime_type)
          VALUES (${fx.schoolB}, ${inputA}, 'gs://bucket/hijack.pdf', 'application/pdf')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });
});
