import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getSignageSnippets } from "../../src/queries/signage-snippets.js";
import { createSql, getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * signage_snippets の RLS（公開参照マスタ特例）を実 PG で検証する（weather_warnings の手本クローン）。
 *
 * 検証の核（Reviewer 重点）:
 *   - **全ロール + 匿名サイネージが SELECT 可**（signage_snippets_read_all, USING (true)）。静的コンテンツは公開・非 PII。
 *     ★ ADR-016 のサイネージ匿名コンテキスト（role 未設定 / school_id のみ or 無し）が確実に読めること。
 *   - **非 system は INSERT / UPDATE / DELETE 不可**（signage_snippets_write_system_*）。書込みは system に閉じる。
 *   - `getSignageSnippets`（匿名サイネージ経路）が active 行を読み、カテゴリごとに決定論で 1 件返すこと。
 *
 * 接続ロールは superuser だが、トランザクション内で `SET LOCAL ROLE kimiterrace_app` に降格して RLS を
 * 実際に効かせる（さもないと所有者バイパスで vacuous になる）。
 */
describeOrSkip("RLS: signage_snippets", () => {
  // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
  const sql = createSql(url!);
  let fx: Awaited<ReturnType<typeof seedBaseFixture>>;

  beforeEach(async () => {
    fx = await seedBaseFixture(sql);
    // signage_snippets は seedBaseFixture の TRUNCATE 対象外（school_id 非保持の cross-tenant 参照で
    // schools CASCADE に巻き込まれない）ため、テスト間で行が残らないよう明示クリアする。
    await sql.unsafe("TRUNCATE signage_snippets RESTART IDENTITY;");
    // 閲覧テスト用の固定行を owner 接続（RLS バイパス）で投入。各カテゴリ + on_this_day を 1 件以上。
    await sql`
      INSERT INTO signage_snippets (category, body, reading, meaning, attribution, month_day, active)
      VALUES
        ('quote', '為せば成る', NULL, NULL, '上杉鷹山', NULL, true),
        ('quote', '千里の道も一歩から', NULL, NULL, '老子', NULL, true),
        ('idiom', '切磋琢磨', 'せっさたくま', '互いに励まし競い合う', NULL, NULL, true),
        ('word', 'diligent', '/ˈdɪlɪdʒənt/', '勤勉な', NULL, NULL, true),
        ('on_this_day', '元日', NULL, '年のはじめを祝う', NULL, '01-01', true),
        ('quote', '無効な名言', NULL, NULL, NULL, NULL, false)
    `;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  // --- ★ SELECT 全開放（全ロール + 匿名） ---

  it("全テナントロール（school_admin/teacher/student/guardian）が SELECT できる", async () => {
    for (const role of ["school_admin", "teacher", "student", "guardian"] as const) {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_user_role', ${role}, true)`;
        const rows = await tx`SELECT id FROM signage_snippets WHERE category = 'quote'`;
        expect(rows.length, `role=${role}`).toBeGreaterThan(0);
      });
    }
  });

  it("★ サイネージ匿名コンテキスト（role 未設定・school_id のみ）でも SELECT できる（ADR-016）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      // school_id のみ set、role / userId は set しない（匿名サイネージ = deny-by-default 接続）。
      // 静的コンテンツは cross-tenant 共有なので school_id に関係なく signage_snippets_read_all で読める。
      await tx`SELECT set_config('app.current_school_id', ${fx.schoolA}, true)`;
      const rows = await tx`SELECT id FROM signage_snippets`;
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it("context 完全無し（role も school_id も無し）でも SELECT できる（公開データ、USING true）", async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      const rows = await tx`SELECT id FROM signage_snippets`;
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  // --- ★ 書き込みは system のみ ---

  it("非 system（school_admin）は INSERT できない（signage_snippets_write_system_insert）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`SELECT set_config('app.current_school_id', '00000000-0000-0000-0000-000000000001', true)`;
        await tx`SELECT set_config('app.current_user_role', 'school_admin', true)`;
        await tx`
          INSERT INTO signage_snippets (category, body) VALUES ('quote', '不正な投入')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("匿名（role 無し）も INSERT できない（deny-by-default）", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
        await tx`
          INSERT INTO signage_snippets (category, body) VALUES ('quote', '匿名投入')
        `;
      }),
    ).rejects.toThrow(/row-level security|new row violates/i);
  });

  it("非 system（teacher）は UPDATE / DELETE できない（0 行 or 拒否、改竄防止）", async () => {
    // UPDATE: signage_snippets_write_system_update の USING が false → 0 行（エラーにはならないが変更不可）。
    const updated = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx`UPDATE signage_snippets SET body = '改竄' WHERE category = 'idiom' RETURNING id`;
    });
    expect(updated.length).toBe(0);

    const deleted = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'teacher', true)`;
      return tx`DELETE FROM signage_snippets WHERE category = 'idiom' RETURNING id`;
    });
    expect(deleted.length).toBe(0);

    // owner 接続で無傷であることを確認。
    await sql`RESET ROLE`;
    const survive = await sql`SELECT body FROM signage_snippets WHERE category = 'idiom'`;
    expect(survive.length).toBe(1);
    expect(survive[0].body).toBe("切磋琢磨");
  });

  it("system_admin は INSERT できる（seed / コンテンツ投入経路）", async () => {
    const id = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kimiterrace_app");
      await tx`SELECT set_config('app.current_user_role', 'system_admin', true)`;
      const rows = await tx<{ id: string }[]>`
        INSERT INTO signage_snippets (category, body, attribution)
        VALUES ('quote', 'system 投入の名言', '出典')
        RETURNING id`;
      return rows[0]?.id;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // --- ★ 読み取りクエリ（匿名サイネージ経路） ---

  it("getSignageSnippets: 匿名サイネージ context で active 行をカテゴリごとに 1 件返す", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const result = await db.transaction(async (tx) => {
        // 匿名サイネージ context（role 無し）に降格。signage_snippets_read_all で読めることを実証。
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        // 元日（01-01）に固定して on_this_day を一致させる。
        return getSignageSnippets(tx, new Date(Date.UTC(2026, 0, 1, 12)));
      });
      expect(result.quote).not.toBeNull();
      expect(result.idiom?.body).toBe("切磋琢磨");
      expect(result.word?.body).toBe("diligent");
      expect(result.onThisDay?.body).toBe("元日");
      // active=false の行は表示候補に含めない（WHERE active = true）。
      expect(result.quote?.body).not.toBe("無効な名言");
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });

  it("getSignageSnippets: 記念日が無い日は onThisDay = null（fail-soft）", async () => {
    // biome-ignore lint/style/noNonNullAssertion: describeOrSkip で url 有り
    const client = postgres(url!, { max: 1, onnotice: () => {} });
    try {
      const db = drizzle(client);
      const result = await db.transaction(async (tx) => {
        await tx.execute(dsql`SET LOCAL ROLE kimiterrace_app`);
        return getSignageSnippets(tx, new Date(Date.UTC(2026, 2, 14, 12))); // 03-14（記念日 seed 無し）
      });
      expect(result.onThisDay).toBeNull();
      // ローテ系は引き続き出る。
      expect(result.quote).not.toBeNull();
    } finally {
      await client.unsafe("RESET ROLE").catch(() => {});
      await client.end({ timeout: 5 });
    }
  });
});
