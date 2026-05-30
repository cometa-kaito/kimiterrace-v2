import { type ResolvedMagicLink, resolveMagicLink } from "@kimiterrace/db";
import { cookies } from "next/headers";
import { getDb } from "../db";
import { hashToken } from "./token";

/**
 * F05: 生徒の匿名セッション (magic link 経由)。**サーバー専用**。
 *
 * 設計 (F05 受け入れ条件 + 即時失効):
 * - cookie には **平文トークンのみ** を入れる (個人特定情報は一切持たない)。token は元々
 *   生徒が受け取った URL の一部であり、credential そのもの。`httpOnly` cookie に移すことで
 *   URL/履歴/Referer から外し、JS からも読めなくする。
 * - **毎リクエストで再解決する** (`resolveStudentSession`)。署名 cookie に school_id 等を
 *   埋め込むと失効が cookie 期限まで効かない。token → `resolve_magic_link` を都度引くことで、
 *   教員が失効/期限切れにした瞬間から null になり 410 Gone に倒せる (F05「失効後は 410」)。
 * - cookie 自体は 24h で保持 (ブラウザを閉じても維持)。ただし有効性は毎回 DB 側が決める。
 */

/** 生徒セッション cookie 名。Identity Platform の `__session` とは別系統 (教員/生徒を混同しない)。 */
export const STUDENT_SESSION_COOKIE = "__student_session";

/** cookie 保持期間 24h (秒)。F05: ブラウザを閉じても 24h は保持。 */
export const STUDENT_SESSION_MAX_AGE_S = 24 * 60 * 60;

/** 生徒セッション cookie の属性。token は credential なので httpOnly + secure。 */
export function studentSessionCookie(token: string): {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    name: STUDENT_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STUDENT_SESSION_MAX_AGE_S,
  };
}

/**
 * 現在のリクエストの生徒セッション cookie を読み、token を再解決する。
 *
 * @returns 有効なら `{ id, schoolId, classId }`、cookie 無し/失効/期限切れ/不正なら null。
 */
export async function resolveStudentSession(): Promise<ResolvedMagicLink | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(STUDENT_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }
  return await resolveMagicLink(getDb(), hashToken(token));
}
