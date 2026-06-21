import { schools } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "./session";
import { withUserSession } from "../db";

/**
 * 現在のテナントユーザーが所属する学校名を 1 件返す（ヘッダのオリエンテーション表示用）。
 *
 * 「いま自分はどの学校の管理画面にいるのか」を欠落させない（v2 UX 発見 v2-sch-uo7）。
 *
 * - **テナントロール限定**: school_admin / teacher / student / guardian のみ。`schoolId` を持つ前提。
 *   system_admin は特定校に属さない（全校横断）ため `null` を返し、ヘッダには学校名を出さない。
 * - **RLS（ルール2）**: 既に解決済みの `user` で `withUserSession` の自校コンテキスト tx を開き、
 *   `tenant_isolation` policy で自校に限定される（手書き WHERE school_id は書かない）。`schools` には
 *   `school_id` 列が無いが、id 一致 + RLS 配下で自校のみが見える。
 * - **表示専用**: 取得失敗・該当なしは `null`（ヘッダは学校名を省略するだけで、認可判断には使わない）。
 */
export async function getCurrentSchoolName(user: AuthUser): Promise<string | null> {
  if (user.role === "system_admin" || !user.schoolId) {
    return null;
  }
  const schoolId = user.schoolId;
  try {
    return await withUserSession(user, async (tx) => {
      const rows = await tx
        .select({ name: schools.name })
        .from(schools)
        .where(eq(schools.id, schoolId))
        .limit(1);
      return rows[0]?.name ?? null;
    });
  } catch {
    // ヘッダ表示はベストエフォート。失敗してもページ本体は描画する。
    return null;
  }
}
