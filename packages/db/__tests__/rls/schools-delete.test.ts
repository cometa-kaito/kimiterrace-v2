import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, withTenantContext } from "../../src/client.js";
import { deleteSchool } from "../../src/queries/schools.js";
import { getConnectionUrl, seedBaseFixture } from "../_setup/db.js";

const url = getConnectionUrl();
const describeOrSkip = url ? describe : describe.skip;

/**
 * #48-L4 (#123): deleteSchool を実 PG (RLS + FK RESTRICT 込み) で検証する。
 *
 * - system_admin は空の学校を削除でき、子データが残る学校は FK RESTRICT (23503) で拒否される。
 * - テナント (school_admin) は他校を削除できない (tenant_isolation_delete で 0 行)。
 */
describeOrSkip(
  "#48-L4 deleteSchool (空校のみ削除可 / 子データは FK 拒否 / テナント越境不可)",
  () => {
    // biome-ignore lint/style/noNonNullAssertion: describe.skip 時は実行されない
    const { sql: raw, db } = createDbClient(url!);
    const APP = { appRole: "kimiterrace_app" };
    let fx: Awaited<ReturnType<typeof seedBaseFixture>>;
    let emptyId: string;

    beforeAll(async () => {
      fx = await seedBaseFixture(raw);
    });

    beforeEach(async () => {
      await raw`RESET ROLE`;
      await raw`DELETE FROM schools WHERE name LIKE 'L4空校%'`;
      // 子データを一切持たない空の学校を 1 件用意する (superuser で直接投入)。
      const [row] = await raw<{ id: string }[]>`
      INSERT INTO schools (name, prefecture) VALUES ('L4空校', '岐阜県') RETURNING id
    `;
      emptyId = row.id;
    });

    afterAll(async () => {
      // feedback は school_id=NULL になって生存しうる (SET NULL 例外テスト) ため school_name で掃除。
      await raw`DELETE FROM feedback WHERE school_name = 'L4空校'`;
      await raw`DELETE FROM schools WHERE name LIKE 'L4空校%'`;
      await raw.end({ timeout: 5 });
    });

    /** drizzle ラップ越しに FK 違反 (23503) を判定する。 */
    async function expectFkRejected(p: Promise<unknown>): Promise<void> {
      const err = (await p.then(
        () => null,
        (e) => e,
      )) as { message?: string; cause?: { message?: string; code?: string } } | null;
      expect(err, "削除は FK で拒否されるべき").not.toBeNull();
      const text = `${err?.message ?? ""} ${err?.cause?.message ?? ""} ${err?.cause?.code ?? ""}`;
      expect(text).toMatch(/foreign key|violates foreign key|23503/i);
    }

    it("system_admin → 空の学校を削除でき、行が消える", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "system_admin" },
        (tx) => deleteSchool(tx, emptyId),
        APP,
      );
      expect(rows.map((r) => r.id)).toEqual([emptyId]);
      const remaining = await raw`SELECT id FROM schools WHERE id = ${emptyId}`;
      expect(remaining).toHaveLength(0);
    });

    it("system_admin → 子データ (users) が残る学校は FK RESTRICT で拒否", async () => {
      // schoolA は fixture の userA が参照しているため削除できない。
      await expectFkRejected(
        withTenantContext(
          db,
          { userId: fx.sysAdmin, role: "system_admin" },
          (tx) => deleteSchool(tx, fx.schoolA),
          APP,
        ),
      );
      // 拒否後も schoolA は残る。
      const remaining = await raw`SELECT id FROM schools WHERE id = ${fx.schoolA}`;
      expect(remaining).toHaveLength(1);
    });

    it("system_admin → feedback だけ参照する学校は削除でき、feedback.school_id は SET NULL で PII 行が生存 (#239 H-1 cross-tenant 例外)", async () => {
      // feedback.school_id は cross-tenant の任意参照で ON DELETE SET NULL (schema/feedback.ts)。
      // 子が feedback のみの学校は「空校」扱いで削除でき、PII (student_episode) を含む feedback 行は
      // school_id=NULL で生存して system_admin の閲覧対象に残る (RESTRICT ではない = doc の例外)。
      const [fb] = await raw<{ id: string }[]>`
        INSERT INTO feedback (school_id, school_name, student_reaction, teacher_utility, student_episode)
        VALUES (${emptyId}, 'L4空校', 4, 4, '田中太郎さんが喜んでいた')
        RETURNING id
      `;
      const rows = await withTenantContext(
        db,
        { userId: fx.sysAdmin, role: "system_admin" },
        (tx) => deleteSchool(tx, emptyId),
        APP,
      );
      // 学校は削除される (feedback の存在は RESTRICT を発火させない)。
      expect(rows.map((r) => r.id)).toEqual([emptyId]);
      const remainingSchool = await raw`SELECT id FROM schools WHERE id = ${emptyId}`;
      expect(remainingSchool).toHaveLength(0);
      // feedback 行は SET NULL で生存し、PII (student_episode) は失われない。
      const survived = await raw<{ school_id: string | null; student_episode: string | null }[]>`
        SELECT school_id, student_episode FROM feedback WHERE id = ${fb.id}
      `;
      expect(survived).toHaveLength(1);
      expect(survived[0]?.school_id).toBeNull();
      expect(survived[0]?.student_episode).toBe("田中太郎さんが喜んでいた");
      await raw`DELETE FROM feedback WHERE id = ${fb.id}`;
    });

    it("school_admin (B) → 他校 (空校) の削除は 0 行 (tenant_isolation_delete で不可視)", async () => {
      const rows = await withTenantContext(
        db,
        { userId: fx.userB, schoolId: fx.schoolB, role: "school_admin" },
        (tx) => deleteSchool(tx, emptyId),
        APP,
      );
      expect(rows).toHaveLength(0);
      // 空校は消えずに残る。
      const remaining = await raw`SELECT id FROM schools WHERE id = ${emptyId}`;
      expect(remaining).toHaveLength(1);
    });
  },
);
