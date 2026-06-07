import { isTeacherLoginEnabled, listTeacherLoginSchools } from "@kimiterrace/db";
import { getDb } from "../db";
import { teacherAccountEmail } from "./teacher-account";

/**
 * ADR-032: 教員「学校共通パスワード」ログインのサーバー処理。**サーバー専用**（公開 route から呼ぶ）。
 *
 * セッション無しの公開経路のため、学校解決は `system_admin` role context（packages/db の query 層が内部で
 * 張る）で cross-tenant に行う。パスワード検証は **Identity Platform の REST `signInWithPassword`** に委ね
 * （本 DB にハッシュを持たない、ルール5）、得た idToken を既存の `createSessionCookie` で session cookie 化
 * する（route 側）。`createCustomToken`（signBlob 権限要）は使わない。
 */

/** ログイン対象の学校解決結果。 */
export type TeacherSchoolResolution =
  | { ok: true; schoolId: string }
  | { ok: false; reason: "select_required" | "not_enabled" };

/**
 * ログインに使う学校を解決する。
 * - `schoolId` 指定あり: その学校が共通ログイン有効なら採用、無効なら `not_enabled`。
 * - 指定なし: 有効校がちょうど 1 校ならそれを採用（=「パスワードのみ」運用）、複数なら `select_required`、
 *   0 校なら `not_enabled`。
 */
export async function resolveTeacherLoginSchool(
  schoolId: string | undefined,
): Promise<TeacherSchoolResolution> {
  const db = getDb();
  if (schoolId) {
    const enabled = await isTeacherLoginEnabled(db, schoolId);
    return enabled ? { ok: true, schoolId } : { ok: false, reason: "not_enabled" };
  }
  const candidates = await listTeacherLoginSchools(db);
  if (candidates.length === 1) {
    return { ok: true, schoolId: candidates[0]!.id };
  }
  return { ok: false, reason: candidates.length === 0 ? "not_enabled" : "select_required" };
}

/**
 * Identity Platform の REST `signInWithPassword` で共通教員アカウントにサインインし idToken を得る。
 * 公開 API キー（`NEXT_PUBLIC_FIREBASE_API_KEY`、秘密ではない）で叩く。失敗（パスワード不一致 / アカウント
 * 無効 / 設定不備）は **null**（route が 401 に写像。理由を細分化して列挙攻撃の手掛かりを与えない）。
 */
export async function signInSharedTeacher(
  schoolId: string,
  password: string,
): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) {
    return null;
  }
  const email = teacherAccountEmail(schoolId);
  let res: Response;
  try {
    res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const json = (await res.json().catch(() => null)) as { idToken?: unknown } | null;
  return json && typeof json.idToken === "string" && json.idToken.length > 0 ? json.idToken : null;
}
