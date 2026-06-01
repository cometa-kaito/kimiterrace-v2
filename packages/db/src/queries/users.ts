import { inArray } from "drizzle-orm";
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
 * 当該テナントの職員氏名を、マスキング供給用に重複排除して返す。
 *
 * - **在職状態 (`is_active`) で絞らない**: マスキングは false-negative を避けるのが目的で、退職直後の
 *   職員氏名が transcript に紛れた場合も roster で確定マスクしたい。`is_active=false` を除外すると
 *   その名は `findUnmaskedPii` の監視対象からも外れ、書式 PII でもないため素通りで Vertex に届く
 *   (ルール4 の安全側に反する)。トークン番号消費は些少なため全職員を対象にする (#317 Reviewer M-1)。
 * - 同名は 1 度だけ返す（{@link maskPII} のトークン番号の無駄消費を避ける）。空文字は除外。
 *
 * @returns 職員の表示名（正規表記）の配列。順序は安定させない（マスクは最長一致優先のため非依存）。
 */
export async function listStaffDisplayNames(tx: TenantTx): Promise<string[]> {
  const rows = await tx
    .select({ displayName: users.displayName })
    .from(users)
    .where(inArray(users.role, [...STAFF_ROLES]));

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
