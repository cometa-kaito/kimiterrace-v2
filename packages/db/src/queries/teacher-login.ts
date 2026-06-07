import { and, asc, eq } from "drizzle-orm";
import { type KimiterraceDb, type TenantTx, withTenantContext } from "../client.js";
import { schools } from "../schema/schools.js";
import { users } from "../schema/users.js";

/**
 * ADR-032: 教員「学校共通パスワード」ログインの DB クエリ層。
 *
 * 認証モデルは ADR-003（Identity Platform session cookie）を維持しつつ、教員は **学校ごとの共通
 * パスワード 1 つ**でログインする（ユーザー判断: 学校側の per-教員 ID 登録は工数が高い、個人帰属の喪失は
 * 受容）。パスワードは IdP の per-school 共通教員アカウントに保管し（本 DB には持たない、ルール5）、
 * 本テーブルは「どの学校が共通ログインを提供しているか」(`teacher_login_enabled`) と、共通教員の
 * `users` 行（created_by FK 充足用）だけを扱う。
 *
 * ## 公開ログイン経路は system_admin context で cross-tenant 解決（ルール2 / ADR-019）
 * ログイン画面・ログイン route は**セッション無し**で呼ばれるため、`recordPresenceEvent` / `pollTvConfig`
 * と同じく `system_admin` role context（`system_admin_full_access` policy）で全校横断に解決する。
 * BYPASSRLS は使わない。`listTeacherLoginSchools` が返すのは学校 id/名のみ（パスワードや内部秘密は返さない）。
 *
 * ## provisioning（`ensureSharedTeacherUserRow` / `setSchoolTeacherLoginEnabled`）は system_admin tx 内
 * system_admin の Server Action（`withSession`）の tx 内で呼ぶ。`users` 行 INSERT と enabled フラグ更新は
 * `system_admin_full_access` の WITH CHECK で通る（schools/tv_devices INSERT と同方針）。
 */

/** ログイン画面の学校選択肢（共通教員ログインが有効な学校）。id/名のみ。 */
export type TeacherLoginSchool = { id: string; name: string };

/**
 * 共通教員ログインが有効な学校を名前順で列挙する（公開ログイン画面用）。system_admin context で全校横断。
 * 1 校だけならログイン画面は学校選択を出さず「パスワードのみ」になる。
 */
export async function listTeacherLoginSchools(
  db: KimiterraceDb,
  options?: { appRole?: string },
): Promise<TeacherLoginSchool[]> {
  return withTenantContext(
    db,
    { role: "system_admin" },
    async (tx) =>
      tx
        .select({ id: schools.id, name: schools.name })
        .from(schools)
        .where(eq(schools.teacherLoginEnabled, true))
        .orderBy(asc(schools.name), asc(schools.id)),
    options,
  );
}

/**
 * 指定学校が共通教員ログイン有効か（ログイン route が schoolId 指定を検証する用）。
 * system_admin context で解決（公開経路・セッション無し）。
 */
export async function isTeacherLoginEnabled(
  db: KimiterraceDb,
  schoolId: string,
  options?: { appRole?: string },
): Promise<boolean> {
  return withTenantContext(
    db,
    { role: "system_admin" },
    async (tx) => {
      const rows = await tx
        .select({ id: schools.id })
        .from(schools)
        .where(and(eq(schools.id, schoolId), eq(schools.teacherLoginEnabled, true)))
        .limit(1);
      return rows.length === 1;
    },
    options,
  );
}

/**
 * 共通教員アカウントの `users` 行を冪等に用意する（system_admin context tx 内で呼ぶ）。
 *
 * `id` / `identity_uid` には IdP の共通教員 localId（deterministic uid）を入れる。これにより
 * 教員がコンテンツを保存する際の `created_by`（users.id FK）が解決でき、ADR-003 の localId==users.id
 * 前提も満たす。既存なら何もしない（`ON CONFLICT (id) DO NOTHING`）。created_by/updated_by は NULL（システム）。
 */
export async function ensureSharedTeacherUserRow(
  tx: TenantTx,
  params: { uid: string; schoolId: string; displayName: string },
): Promise<void> {
  await tx
    .insert(users)
    .values({
      id: params.uid,
      identityUid: params.uid,
      schoolId: params.schoolId,
      role: "teacher",
      displayName: params.displayName,
    })
    .onConflictDoNothing({ target: users.id });
}

/**
 * 学校の `teacher_login_enabled` を設定する（system_admin context tx 内）。
 * `updated_at` を明示更新する（auditColumns の updated_at は INSERT default のみ、
 * [[feedback_updatedat_explicit_on_update]]）。`updated_by` は system_admin 起点で NULL。
 */
export async function setSchoolTeacherLoginEnabled(
  tx: TenantTx,
  params: { schoolId: string; enabled: boolean },
): Promise<void> {
  await tx
    .update(schools)
    .set({ teacherLoginEnabled: params.enabled, updatedAt: new Date() })
    .where(eq(schools.id, params.schoolId));
}
