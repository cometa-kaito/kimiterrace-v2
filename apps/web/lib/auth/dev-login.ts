import {
  DEVLOGIN_TEST_ADMIN_EMAIL,
  DEVLOGIN_TEST_ADMIN_UID,
  auditLog,
  ensureDevLoginTestSchool,
  ensureDevLoginTestUsers,
  findExistingSchoolAdminUid,
  findExistingTeacherLoginSchoolId,
} from "@kimiterrace/db";
import { getAdminAuth } from "./adminApp";
import { getDb, withUserSession } from "../db";
import { extractClientMeta } from "../magic-link/client-meta";
import { type DevLoginRole, getDevLoginResolveHint } from "./dev-login-config";
import type { AuthUser } from "./session";
import { sharedTeacherUid, teacherAccountEmail } from "./teacher-account";

/**
 * staging 限定 **dev-login** の uid 解決 / 冪等プロビジョニングと監査記録（ADR-003 / ADR-032）。**サーバー専用**。
 *
 * 「**パスワードを打たない・保存しない**」でセッションを得る手段。任意の email/uid をリクエストから受け取らず、
 * 許可ロール（teacher / admin）に対応する **既存アカウントの uid を DB / IdP から解決**する。解決できた uid は
 * route 側で `createSessionCookieForUid`（custom token → idToken → session cookie）に渡し、通常ログインと同一の
 * `__session` を発行する（= 本物のセッション。RLS の school スコープが正しく効く）。
 *
 * ## アカウント解決方式（既存解決 → 無ければ冪等作成）
 * - **teacher**: ① config ヒント（schoolId）or ② DB の `teacher_login_enabled` 有効校を 1 校解決し、その学校の
 *   共通教員 uid（`sharedTeacherUid`）を対象にする。無ければ **dev 専用テスト校 "DEVLOGIN_TEST" を冪等作成**し、
 *   その共通教員を対象にする。
 * - **admin**: ① config ヒント（uid）or ② DB の既存 school_admin を 1 件解決。無ければ dev 専用テスト校配下に
 *   **dev 専用 school_admin を冪等作成**する。
 *
 * 新規作成は **dev-login 経路かつ staging ゲート内のみ**（route が isProdLikeEnv / APP_ENV / ゲート鍵を通した後に
 * だけ本モジュールを呼ぶ）。IdP アカウント（custom claims = role/school_id）と `users` 行の両方を冪等に用意する。
 *
 * ## 秘密を持たない（ルール5）
 * パスワードは IdP にも本 DB にも作らない（custom token 経路ゆえ password 不要）。IdP アカウントは password 未設定
 * のまま `createUser` + `setCustomUserClaims` で用意する（通常ログイン経路では password 未設定ゆえサインイン不可。
 * dev-login の custom token 経路のみがセッションを得られる = 攻撃面を増やさない）。
 */

/** dev-login の対象アカウント解決結果（uid のみ。PII / 秘密は持たない）。 */
type DevLoginTarget = { uid: string };

/** firebase-admin のエラーコードを取り出す（既存衝突の冪等判定用）。 */
function adminErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function isUserAlreadyExists(error: unknown): boolean {
  const code = adminErrorCode(error);
  return code === "auth/uid-already-exists" || code === "auth/email-already-exists";
}

/**
 * IdP アカウントを **password 無し**で冪等に用意し、role/school_id の custom claims を張る。
 *
 * 既存（uid/email 衝突）なら custom claims の再設定のみ（idempotent）。password は決して設定しない
 * （dev-login の custom token 経路だけがこのアカウントでセッションを得られる）。
 */
async function ensureIdpAccount(params: {
  uid: string;
  email: string;
  displayName: string;
  role: "teacher" | "school_admin";
  schoolId: string;
}): Promise<void> {
  const auth = getAdminAuth();
  try {
    await auth.createUser({
      uid: params.uid,
      email: params.email,
      displayName: params.displayName,
    });
  } catch (error) {
    if (!isUserAlreadyExists(error)) throw error;
    // 既存アカウントはそのまま使う（password 未設定のまま）。email 等は触らない。
  }
  // role/school_id を claim にセット（session token → RLS context）。uid は localId（claim ではない、ADR-003）。
  await auth.setCustomUserClaims(params.uid, { role: params.role, school_id: params.schoolId });
}

/**
 * 指定ロールの **既存** uid を解決する。無ければ null（呼出側が冪等作成へフォールバック）。
 * config ヒント（schoolId / uid）があればそれを最優先する。
 */
async function resolveExistingTarget(role: DevLoginRole): Promise<DevLoginTarget | null> {
  const hint = getDevLoginResolveHint(role);
  if (role === "teacher") {
    // ヒント schoolId → その共通教員 uid。無ければ DB の有効校を 1 校解決。
    const schoolId = hint?.schoolId ?? (await findExistingTeacherLoginSchoolId(getDb()));
    return schoolId ? { uid: sharedTeacherUid(schoolId) } : null;
  }
  // admin: ヒント uid → そのまま。無ければ DB の既存 school_admin を 1 件解決。
  const uid = hint?.uid ?? (await findExistingSchoolAdminUid(getDb()));
  return uid ? { uid } : null;
}

/**
 * 既存解決に失敗したときの **冪等作成**フォールバック。dev 専用テスト校 "DEVLOGIN_TEST" を作り、
 * teacher / admin の IdP アカウント + `users` 行を用意して uid を返す。**staging ゲート内のみ呼ばれる**。
 */
async function provisionTestTarget(role: DevLoginRole): Promise<DevLoginTarget> {
  // 各扉に getDb() を直接渡す（RLS チョークポイント監査の「扉」allowlist 経路。内部で system_admin 文脈を張る）。
  const schoolId = await ensureDevLoginTestSchool(getDb());
  const teacherUid = sharedTeacherUid(schoolId);
  // users 行（teacher + school_admin）を冪等作成（FK / created_by 充足）。
  await ensureDevLoginTestUsers(getDb(), { schoolId, teacherUid });
  if (role === "teacher") {
    await ensureIdpAccount({
      uid: teacherUid,
      email: teacherAccountEmail(schoolId),
      displayName: "教員（dev-login テスト）",
      role: "teacher",
      schoolId,
    });
    return { uid: teacherUid };
  }
  await ensureIdpAccount({
    uid: DEVLOGIN_TEST_ADMIN_UID,
    email: DEVLOGIN_TEST_ADMIN_EMAIL,
    displayName: "学校管理者（dev-login テスト）",
    role: "school_admin",
    schoolId,
  });
  return { uid: DEVLOGIN_TEST_ADMIN_UID };
}

/**
 * 指定ロールの dev-login 対象 uid を解決する（既存解決 → 無ければ冪等作成）。
 *
 * 失敗（DB / IdP エラー）は **null**（route が 404 に写像）。任意 email/uid は受け取らない。
 * 既存解決時は IdP アカウントが既に provisioning 済（通常運用のアカウント）である前提。冪等作成パスのみが
 * IdP アカウントを生やす（dev 専用テストアカウント）。秘密値は throw メッセージ・ログに出さない（ルール5）。
 */
export async function resolveDevLoginUid(role: DevLoginRole): Promise<string | null> {
  try {
    const existing = await resolveExistingTarget(role);
    const target = existing ?? (await provisionTestTarget(role));
    return target.uid;
  } catch {
    // 解決 / プロビジョニング失敗は 404 に畳む（列挙対策・理由はログに出さない、ルール5）。
    return null;
  }
}

/**
 * dev-login の使用を `audit_log` に追記する（CLAUDE.md ルール1 / NFR04）。
 *
 * **既に発行済みセッションの actor（解決済み AuthUser）として記録する**: dev-login で得た session cookie を
 * `verifySessionCookie` で検証した結果の user をそのまま RLS context に張り（`withUserSession`）、その user の
 * `actor_user_id` / `school_id` で 1 行 insert する。これにより「staging で誰のセッションとして dev-login が
 * 使われたか」を、漏洩時にも append-only chain で立証できる。`audit_op` に read が無いため
 * `dev_login_access` 論理 subject への insert として記録する（download-audit / view-audit と同方針）。
 *
 * 失敗（DB エラー等）は **throw せず握り潰す**: 監査記録の失敗で正規のサインインを巻き戻さない（dev-login の
 * ログイン自体は成立済み）。記録漏れは別途検知する想定。秘密値は diff に載せない。
 */
export async function recordDevLoginAudit(
  user: AuthUser,
  role: DevLoginRole,
  requestHeaders: Headers,
  keyVersion: string | null,
): Promise<void> {
  const { ip, userAgent } = extractClientMeta(requestHeaders);
  const isSystemAdmin = user.role === "system_admin";
  // 非 system_admin（teacher / school_admin）は audit_log_insert policy 上 actor_user_id を自分の uid に
  // 完全一致させる必要がある（NULL / 詐称は拒否、migration 0005）。dev-login の対象は teacher / admin のみ。
  const actorUserId = isSystemAdmin ? null : user.uid;
  try {
    await withUserSession(user, async (tx) => {
      await tx.insert(auditLog).values({
        actorUserId,
        actorIdentityUid: user.uid,
        schoolId: user.schoolId ?? null,
        tableName: "dev_login_access",
        recordId: null,
        operation: "insert",
        // PII / 秘密値は載せない。どのロールで・どの鍵世代で staging dev-login したかのメタのみ。
        // keyVersion は非秘密のローテ世代ラベル（未設定なら "unknown"）。濫用調査で鍵世代の追跡に使う。
        diff: { action: "dev_login", role, keyVersion: keyVersion ?? "unknown" },
        ipAddress: ip,
        userAgent,
        rowHash: "",
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    });
  } catch {
    // 監査記録の失敗で正規サインインを巻き戻さない（ベストエフォート）。理由はログに出さない（ルール5）。
  }
}
