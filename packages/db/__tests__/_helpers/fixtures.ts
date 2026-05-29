/**
 * テスト fixtures。**superuser** で投入する（RLS をバイパスして 2 校分のデータを揃える）。
 * RLS 検証は別途 `app_user` ロールで実施。
 */
import { randomUUID } from "node:crypto";
import type { TestPg } from "./postgres.js";

export interface Tenant {
  schoolId: string;
  schoolName: string;
  userId: string;
}

/**
 * 2 校 (school_a / school_b) を作って各々に 1 ユーザーを置く。
 */
export async function seedTwoSchools(pg: TestPg): Promise<{ a: Tenant; b: Tenant }> {
  const schoolAId = randomUUID();
  const schoolBId = randomUUID();
  const userAId = randomUUID();
  const userBId = randomUUID();

  await pg.admin.unsafe(`
    INSERT INTO "schools" (id, name, prefecture) VALUES
      ('${schoolAId}', 'School A', 'Tokyo'),
      ('${schoolBId}', 'School B', 'Osaka');

    INSERT INTO "users" (id, school_id, identity_uid, role, display_name) VALUES
      ('${userAId}', '${schoolAId}', 'uid-a-1', 'teacher', 'Teacher A'),
      ('${userBId}', '${schoolBId}', 'uid-b-1', 'teacher', 'Teacher B');
  `);

  return {
    a: { schoolId: schoolAId, schoolName: "School A", userId: userAId },
    b: { schoolId: schoolBId, schoolName: "School B", userId: userBId },
  };
}
