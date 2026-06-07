import { createHash } from "node:crypto";
import { getAdminAuth } from "./adminApp";

/**
 * ADR-032: per-school **共通教員アカウント**（Identity Platform）の決定的識別子と provisioning。**サーバー専用**。
 *
 * 教員は「学校共通パスワード 1 つ」でログインする。実装は ADR-003 の email+password / session cookie を
 * 維持し、学校ごとに 1 つの IdP アカウント（deterministic uid + deterministic email）を用意して、その
 * パスワードを共通パスワードにする。パスワードは IdP（Google ハッシュ保管）にのみ置き、本 DB には持たない
 * （ルール5）。`createCustomToken`（signBlob 権限が要る）は使わず、`createUser`/`updateUser`/
 * `setCustomUserClaims`（Auth REST、署名不要）だけで provisioning する。
 *
 * ## localId == users.id（ADR-003 前提）
 * IdP の localId（=uid）を `users.id` と一致させるため、uid は **学校 id から決定的に導く UUIDv5**。
 * これにより session cookie 検証（`decoded.uid` を users.id として扱う）と `created_by` FK が成立する。
 */

/** UUIDv5 名前空間（本アプリの共通教員アカウント用に固定採番した定数 UUID）。 */
const TEACHER_ACCOUNT_NAMESPACE = "9b6f6e7a-1c2d-4e3f-8a9b-0c1d2e3f4a5b";

/** email ドメイン。`.invalid` はメール送信されない予約 TLD（IdP は email/password 認証のみで使用）。 */
const TEACHER_ACCOUNT_EMAIL_DOMAIN = "teacher.kimiterrace.invalid";

/** "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" を 16 バイトに変換。 */
function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/** 16 バイトを UUID 文字列に変換。 */
function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * RFC 4122 UUIDv5（SHA-1 ベースの名前ベース UUID）。同じ (namespace, name) からは常に同じ UUID を返す
 * （決定的）。共通教員アカウントの uid を学校 id から安定導出するために使う。
 */
export function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1")
    .update(uuidToBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // version 5 と RFC 4122 variant をセット（subarray(0,16) ゆえ index 6/8 は常に存在、`?? 0` は型充足）。
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

/** 学校 id から共通教員アカウントの決定的 uid（= users.id）を導く。 */
export function sharedTeacherUid(schoolId: string): string {
  return uuidv5(schoolId, TEACHER_ACCOUNT_NAMESPACE);
}

/** 学校 id から共通教員アカウントの決定的 email を導く（ハイフン除去でローカル部を英数字に保つ）。 */
export function teacherAccountEmail(schoolId: string): string {
  return `t-${schoolId.replace(/-/g, "")}@${TEACHER_ACCOUNT_EMAIL_DOMAIN}`;
}

/** firebase-admin のエラーコード判定。 */
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

function isUserNotFound(error: unknown): boolean {
  return adminErrorCode(error) === "auth/user-not-found";
}

/**
 * 学校の共通教員アカウントを **冪等に** 用意/更新し、パスワードを設定する（system_admin の設定操作）。
 *
 * - 未作成なら `createUser({ uid, email, password })`、既存なら `updateUser` でパスワード/メール更新 + 有効化。
 * - role/school_id を custom claims にセット（session token に載り、RLS context を構成）。
 * - 既存セッションは `revokeRefreshTokens` で失効（パスワード変更を即時反映、安全側）。
 *
 * @returns provisioning した共通教員の uid（= users.id）。
 */
export async function provisionSharedTeacherAccount(
  schoolId: string,
  password: string,
): Promise<{ uid: string }> {
  const auth = getAdminAuth();
  const uid = sharedTeacherUid(schoolId);
  const email = teacherAccountEmail(schoolId);
  try {
    await auth.createUser({ uid, email, password, displayName: "教員（共通アカウント）" });
  } catch (error) {
    if (isUserAlreadyExists(error)) {
      await auth.updateUser(uid, { email, password, disabled: false });
    } else {
      throw error;
    }
  }
  // 教員ロール + テナント結線（session token の custom claims → RLS context）。
  await auth.setCustomUserClaims(uid, { role: "teacher", school_id: schoolId });
  // パスワード変更前に発行済みのセッションは失効させる（共通PW更新の即時反映）。
  await auth.revokeRefreshTokens(uid);
  return { uid };
}

/**
 * 学校の共通教員アカウントを無効化する（共通ログインの停止）。既存セッションも失効させる。
 * アカウントが存在しなければ無視（冪等）。
 */
export async function disableSharedTeacherAccount(schoolId: string): Promise<void> {
  const auth = getAdminAuth();
  const uid = sharedTeacherUid(schoolId);
  try {
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
  } catch (error) {
    if (!isUserNotFound(error)) {
      throw error;
    }
  }
}
