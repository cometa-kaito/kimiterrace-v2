import { and, eq, inArray } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { users } from "../schema/users.js";

/**
 * F03 / CLAUDE.md ルール4: 職員氏名 roster クエリ。
 *
 * Vertex AI 送信前の PII マスキング（{@link maskPII}）に渡す「確実な氏名」の供給源。生徒・保護者は
 * **匿名設計のため roster を持たない**（#289）。マスク対象として roster 化できるのは学校が氏名を
 * 保持する職員（教員 / 学校管理者）のみで、本クエリはその職員氏名を返す。
 *
 * RLS（ADR-019 / ルール2）が school 越境を DB レベルで拒否するため、`tx` のテナントコンテキストに
 * 属する職員氏名だけが返る。呼出側は `withSession` / `withTenantContext` 済みの `tx` を渡すこと。
 */

/** マスキング対象になる職員ロール（生徒・保護者は匿名設計で roster を持たない）。 */
const STAFF_ROLES = ["teacher", "school_admin"] as const;

/**
 * 当該テナントの有効な職員氏名を、マスキング供給用に重複排除して返す。
 *
 * - `is_active = true` の職員のみ（退職者等の名は現入力に出にくく、roster を最小に保つ）。
 * - 同名は 1 度だけ返す（{@link maskPII} のトークン番号の無駄消費を避ける）。空文字は除外。
 *
 * @returns 職員の表示名（正規表記）の配列。順序は安定させない（マスクは最長一致優先のため非依存）。
 */
export async function listStaffDisplayNames(tx: TenantTx): Promise<string[]> {
  const rows = await tx
    .select({ displayName: users.displayName })
    .from(users)
    .where(and(inArray(users.role, [...STAFF_ROLES]), eq(users.isActive, true)));

  const seen = new Set<string>();
  const names: string[] = [];
  for (const { displayName } of rows) {
    const name = displayName.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
