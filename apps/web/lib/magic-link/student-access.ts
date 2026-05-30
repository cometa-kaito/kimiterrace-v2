import { events, type ResolvedMagicLink, withTenantContext } from "@kimiterrace/db";
import { getDb } from "../db";
import type { ClientMeta } from "./client-meta";

/**
 * F05: 生徒の magic link アクセスを `events` に記録する (F07 行動ログ / F05 受け入れ条件)。
 *
 * - 匿名アクセスなので userId は載せない。RLS は school_id のみで張る (`role=student`)。
 *   `withTenantContext` が `app.current_school_id` を設定し、events の tenant_isolation の
 *   WITH CHECK を満たす (CLAUDE.md ルール2: DB レベルでテナント分離)。
 * - IP / User-Agent は payload に入れる (個人特定はしない、集計用)。`type` は既存 enum の
 *   `view` (生徒がクラス面を開いた = 閲覧)。events への INSERT は audit_log を自動発火しない
 *   (本プロジェクトの audit は明示 INSERT 方式) ため、actor NULL でも policy に抵触しない。
 * - **ベストエフォート**: ログ記録の失敗でアクセス自体を妨げない (呼び出し側が try/catch)。
 */
export async function recordStudentAccess(
  resolved: ResolvedMagicLink,
  meta: ClientMeta,
): Promise<void> {
  await withTenantContext(getDb(), { schoolId: resolved.schoolId, role: "student" }, async (tx) => {
    await tx.insert(events).values({
      schoolId: resolved.schoolId,
      type: "view",
      payload: {
        source: "magic_link",
        magicLinkId: resolved.id,
        classId: resolved.classId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  });
}
