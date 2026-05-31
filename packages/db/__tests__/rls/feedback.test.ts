import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listFeedback, submitFeedback } from "../../src/queries/feedback.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * F12 (#48-M): feedback の RLS / 匿名投稿ロジックを検証する。
 *
 * 検証の核 (Reviewer 重点):
 *   - **★ SELECT 漏れ非存在**: 匿名 (context 無し) / app ロール (school_admin/teacher/student/
 *     guardian) は feedback を **1 件も SELECT できない**。任意の school_id を張っても 0 件
 *     (cross-tenant 漏洩防止 = サービス終了級リスクの非存在を実証)。可視は system_admin のみ。
 *   - **匿名 INSERT の扉**: SECURITY DEFINER 関数 submit_feedback は RLS context 無しの
 *     kimiterrace_app でも 1 行 INSERT できる。一方、生 feedback への直接 INSERT は context 無し
 *     では WITH CHECK で拒否 (扉は submit_feedback のみ)。
 *   - **入力検証**: studentReaction / teacherUtility が 1-5 外なら関数が例外で倒す。
 */
describeOrSkip("F12: feedback RLS + 匿名投稿 (#48-M)", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeAll(async () => {
    fx = await seedBaseFixture(sql);
    // owner 接続 (RESET ROLE = RLS バイパス) で閲覧テスト用の固定フィードバックを投入。
    await sql`INSERT INTO feedback (school_name, school_id, classroom_label, student_reaction, teacher_utility, student_episode, improvement)
      VALUES ('テスト高校 A', ${fx.schoolA}, '1-A', 5, 4, '生徒が朝の予定を自分で確認するようになった', 'もう少し文字を大きく')`;
    await sql`INSERT INTO feedback (school_name, school_id, classroom_label, student_reaction, teacher_utility)
      VALUES ('テスト高校 B', ${fx.schoolB}, '2-B', 3, 5)`;
    // school_id NULL (投稿者が uuid 不明) のレコードも入れておく。
    await sql`INSERT INTO feedback (school_name, classroom_label, student_reaction, teacher_utility)
      VALUES ('見学者の学校', '3-C', 4, 4)`;
  });

  beforeEach(async () => {
    await sql`RESET ROLE`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- ★ SELECT 漏れ非存在 (最重要) ---

  it("匿名 (context 無し) の app ロールは feedback を 1 件も SELECT できない", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      // app.current_school_id / app.current_user_role を一切設定しない
      const rows = await tx`SELECT id FROM feedback`;
      expect(rows.length).toBe(0);
    });
  });

  it("school_admin / teacher / student / guardian は (自校 ID を張っても) feedback 0 件", async () => {
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        // 自校 school_id を張る = school_id 一致で見えてしまわないことを実証 (漏洩防止)。
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
        const rows = await tx`SELECT id FROM feedback`;
        expect(rows.length, `role=${role}`).toBe(0);
      });
    }
  });

  it("system_admin は feedback を全件 SELECT できる (cross-tenant)", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const rows = await tx<{ school_name: string }[]>`SELECT school_name FROM feedback`;
      expect(rows.length).toBe(3);
    });
  });

  it("listFeedback は system_admin context で全件を新しい順に返す", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const rows = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'system_admin', true)`);
        return listFeedback(tx);
      });
      expect(rows.length).toBe(3);
      // 全フィールドが射影されている (PII 含む) — system_admin のみが到達する経路。
      expect(rows[0]).toHaveProperty("studentEpisode");
      expect(rows[0]).toHaveProperty("studentReaction");
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("listFeedback は school_admin context では 0 件 (RLS、漏洩防止)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const rows = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        await tx.execute(dsql`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`);
        await tx.execute(dsql`SELECT set_config('app.current_user_role', 'school_admin', true)`);
        return listFeedback(tx);
      });
      expect(rows).toHaveLength(0);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  // --- 匿名 INSERT の扉 (SECURITY DEFINER submit_feedback) ---

  it("submitFeedback: context 無しの kimiterrace_app が 1 行 INSERT できる (SECURITY DEFINER)", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      await client.unsafe("SET ROLE kimiterrace_app");
      const id = await submitFeedback(db, {
        schoolName: "匿名投稿テスト高校",
        classroomLabel: "1-X",
        studentReaction: 5,
        teacherUtility: 3,
        studentEpisode: "とても良かった",
        improvement: "特になし",
      });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      // owner 接続で 1 行入っていることを確認 (RLS バイパス)。
      await client.unsafe("RESET ROLE");
      const [row] = await sql<{ school_name: string; student_reaction: number }[]>`
        SELECT school_name, student_reaction FROM feedback WHERE id = ${id}
      `;
      expect(row.school_name).toBe("匿名投稿テスト高校");
      expect(row.student_reaction).toBe(5);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("deny by default: context 無しの app ロールが feedback へ直接 INSERT すると拒否される", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        // context 無し = system_admin_only の WITH CHECK を満たせない → 拒否
        await tx`INSERT INTO feedback (school_name, student_reaction, teacher_utility)
          VALUES ('直接 INSERT 試行', 3, 3)`;
      }),
    ).rejects.toThrow(/row-level security|new row violates|permission/i);
  });

  it("school_admin も feedback へ直接 INSERT できない (system_admin_only WITH CHECK)", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`INSERT INTO feedback (school_name, school_id, student_reaction, teacher_utility)
          VALUES ('school_admin 直接 INSERT', ${fx.schoolA}, 3, 3)`;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  // --- 入力検証 (1-5 範囲) ---

  it("submit_feedback: studentReaction / teacherUtility が範囲外なら関数が例外で倒す", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    // 関数を **生の postgres-js 接続**で直接呼び、RAISE の原メッセージ (フィールド名を含む) を
    // 検証する。submitFeedback (drizzle) 経由だと DrizzleQueryError が "Failed query: …" で
    // ラップし、原メッセージが .cause 側に移って .toThrow(message 正規表現) と不一致になる
    // (上の RLS 拒否テストと同じく raw client で原エラーを取る方針)。
    const callOutOfRange = (studentReaction: number, teacherUtility: number) =>
      client.unsafe(
        "SELECT submit_feedback(NULL, NULL::uuid, NULL, $1::int, $2::int, NULL, NULL)",
        [studentReaction, teacherUtility],
      );
    try {
      await client.unsafe("SET ROLE kimiterrace_app");
      await expect(callOutOfRange(0, 3)).rejects.toThrow(/student_reaction/i);
      await expect(callOutOfRange(6, 3)).rejects.toThrow(/student_reaction/i);
      await expect(callOutOfRange(3, 9)).rejects.toThrow(/teacher_utility/i);
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });
});
