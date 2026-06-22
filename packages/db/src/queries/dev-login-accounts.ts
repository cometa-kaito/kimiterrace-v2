import { and, asc, eq, sql } from "drizzle-orm";
import { type KimiterraceDb, withTenantContext } from "../client.js";
import { schools } from "../schema/schools.js";
import { users } from "../schema/users.js";

/**
 * staging 限定 **dev-login** のアカウント解決 / 冪等作成（DB 層）。**サーバー専用**。
 *
 * dev-login は「**パスワードを保存も要求もしない**」方式（apps/web の session.createSessionCookieForUid で uid から
 * 直接セッションを発行する）。本モジュールは、その uid を解決するための **DB 側の真実**を扱う:
 *
 * - **既存解決を最優先**: staging DB に既にある共通教員 / school_admin の `users.id`（= IdP localId、ADR-003）を
 *   返す。実データ運用と同じアカウントで体験できるため。
 * - **無ければ dev 専用テスト校 + teacher + school_admin を冪等作成**: 判別可能な専用校（"DEVLOGIN_TEST"）配下に
 *   teacher / school_admin の `users` 行を `ON CONFLICT DO NOTHING` で用意する。**新規作成は dev-login 経路かつ
 *   staging ゲート内からのみ**呼ばれる（呼出側 apps/web が isProdLikeEnv/APP_ENV/ゲート鍵を通した後にのみ実行）。
 *
 * ## RLS（ルール2 / ADR-019）
 * 公開ログイン同様セッション無しの経路だが、対象は cross-tenant 探索 / 専用校作成のため `system_admin` role
 * context（`system_admin_full_access` policy）で読み書きする（teacher-login.ts / seed-staging と同方針）。
 * BYPASSRLS は使わない。`appRole` オプションは BYPASSRLS 接続のテストが app ロールへ降格するため（client.ts）。
 *
 * ## uid モデル（ADR-003 / F11 整合）
 * `users.id == users.identity_uid == IdP localId` を同一 UUID に揃える。これにより
 * `verifySessionCookie().uid`（= token sub = localId）が `users.id` に一致し、created_by FK / RLS が成立する。
 * teacher の uid は学校 id から決定的に導いた共通教員 uid（apps/web の sharedTeacherUid と同一値）を呼出側が渡す。
 *
 * ## 秘密を持たない
 * 本 DB にパスワード（平文 / ハッシュ）は一切置かない（ルール5）。dev-login の「鍵」は env の DEV_LOGIN_CONFIG
 * 側、ログインの credential は IdP 側（custom token 経路ゆえ password すら不要）。本モジュールは users/schools 行だけ。
 */

/** dev-login 専用テスト校の固定 id（判別可能・冪等作成の anchor）。 */
export const DEVLOGIN_TEST_SCHOOL_ID = "de000000-0000-4000-8000-000000000001";

/** dev-login 専用テスト校名（運用画面で一目で「dev-login 用」と分かる）。 */
export const DEVLOGIN_TEST_SCHOOL_NAME = "DEVLOGIN_TEST";

/** dev-login 専用テスト school_admin の固定 uid（= users.id = IdP localId）。 */
export const DEVLOGIN_TEST_ADMIN_UID = "de000000-0000-4000-8000-000000000003";

/** dev-login 専用テスト school_admin の email（判別可能・`.invalid` は送信されない予約 TLD）。 */
export const DEVLOGIN_TEST_ADMIN_EMAIL = "devlogin-admin@dev-login.kimiterrace.invalid";

/** dev-login 専用テスト教員の email（判別可能）。teacher uid は学校 id から決定的に導くため引数で受ける。 */
export const DEVLOGIN_TEST_TEACHER_EMAIL = "devlogin-teacher@dev-login.kimiterrace.invalid";

type Options = { appRole?: string };

/**
 * **既存の**共通教員ログイン有効校（`teacher_login_enabled = true`）を 1 校、名前順で解決する。
 * 0 校なら null（呼出側が dev 専用校を作るシグナル）。id のみ返す（PII / 秘密は返さない）。
 */
export async function findExistingTeacherLoginSchoolId(
  db: KimiterraceDb,
  options?: Options,
): Promise<string | null> {
  return withTenantContext(
    db,
    { role: "system_admin" },
    async (tx) => {
      const rows = await tx
        .select({ id: schools.id })
        .from(schools)
        .where(eq(schools.teacherLoginEnabled, true))
        .orderBy(asc(schools.name), asc(schools.id))
        .limit(1);
      return rows[0]?.id ?? null;
    },
    options,
  );
}

/**
 * **既存の** school_admin（`users.role = 'school_admin'` かつ `is_active`）を 1 件、安定順で解決する。
 * 0 件なら null（呼出側が dev 専用 school_admin を作るシグナル）。uid（= users.id = IdP localId）のみ返す。
 *
 * ## 決定性（どの校の admin になるか）
 * staging に複数テナントのテストデータが入った場合に「最初に作られた任意の校」へ落ちるのを避けるため、
 * **dev-login 専用テスト校（DEVLOGIN_TEST）配下の school_admin を最優先**で選ぶ（`schoolId == DEVLOGIN_TEST` を
 * 先頭に並べ替え、その中で createdAt/id 安定順）。これにより dev-login の admin は既定で dev 専用テナントに収束する。
 * 特定の実在校の admin を使いたい場合は呼出側が `DEV_LOGIN_CONFIG.admin.uid` ヒントで明示する（dev-login.ts が優先採用）。
 * prod には到達しない（route 多層ゲート）ため権限昇格にはならない。
 */
export async function findExistingSchoolAdminUid(
  db: KimiterraceDb,
  options?: Options,
): Promise<string | null> {
  return withTenantContext(
    db,
    { role: "system_admin" },
    async (tx) => {
      const rows = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "school_admin"), eq(users.isActive, true)))
        // DEVLOGIN_TEST 校配下を最優先（0=テスト校 / 1=その他）。同位は createdAt/id で安定化。
        .orderBy(
          sql`case when ${users.schoolId} = ${DEVLOGIN_TEST_SCHOOL_ID} then 0 else 1 end`,
          asc(users.createdAt),
          asc(users.id),
        )
        .limit(1);
      return rows[0]?.id ?? null;
    },
    options,
  );
}

/**
 * dev-login 専用テスト校を冪等作成し、その id を返す（`ON CONFLICT (id) DO NOTHING`）。
 * `teacher_login_enabled = true` を立て、以後の dev-login が「既存解決」で同校の共通教員を引けるようにする。
 * created_by/updated_by は NULL（システム作成）。**staging ゲート内の dev-login 経路からのみ呼ぶ**。
 */
export async function ensureDevLoginTestSchool(
  db: KimiterraceDb,
  options?: Options,
): Promise<string> {
  return withTenantContext(
    db,
    { role: "system_admin" },
    async (tx) => {
      await tx
        .insert(schools)
        .values({
          id: DEVLOGIN_TEST_SCHOOL_ID,
          name: DEVLOGIN_TEST_SCHOOL_NAME,
          prefecture: "（dev-login）",
          teacherLoginEnabled: true,
          notes: "staging 限定 dev-login のテスト校（自動生成）。本番には存在しない。",
        })
        .onConflictDoNothing({ target: schools.id });
      // 既存校だった場合に enabled が落ちていても dev-login 既存解決が引けるよう true を維持する。
      await tx
        .update(schools)
        .set({ teacherLoginEnabled: true, updatedAt: new Date() })
        .where(eq(schools.id, DEVLOGIN_TEST_SCHOOL_ID));
      return DEVLOGIN_TEST_SCHOOL_ID;
    },
    options,
  );
}

/**
 * dev-login 専用テスト校配下の teacher / school_admin の `users` 行を冪等作成する（`ON CONFLICT (id) DO NOTHING`）。
 *
 * `id == identity_uid == IdP localId` を同一 UUID に揃える（ADR-003）。teacher の uid は学校 id から決定的に
 * 導いた共通教員 uid を呼出側（apps/web の sharedTeacherUid）が渡す。created_by/updated_by は NULL（システム）。
 * RLS は `system_admin_full_access`（WITH CHECK）で通る。
 */
export async function ensureDevLoginTestUsers(
  db: KimiterraceDb,
  params: { schoolId: string; teacherUid: string },
  options?: Options,
): Promise<void> {
  await withTenantContext(
    db,
    { role: "system_admin" },
    async (tx) => {
      await tx
        .insert(users)
        .values([
          {
            id: params.teacherUid,
            identityUid: params.teacherUid,
            schoolId: params.schoolId,
            role: "teacher",
            displayName: "教員（dev-login テスト）",
            email: DEVLOGIN_TEST_TEACHER_EMAIL,
          },
          {
            id: DEVLOGIN_TEST_ADMIN_UID,
            identityUid: DEVLOGIN_TEST_ADMIN_UID,
            schoolId: params.schoolId,
            role: "school_admin",
            displayName: "学校管理者（dev-login テスト）",
            email: DEVLOGIN_TEST_ADMIN_EMAIL,
          },
        ])
        .onConflictDoNothing({ target: users.id });
    },
    options,
  );
}
