import { type InferSelectModel, asc, desc, inArray } from "drizzle-orm";
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

/**
 * F11 (#47 / #320): 自校メンバー一覧 1 行の軽量射影。識別 + ロール + 稼働状態のみ。
 * **`email` 等の PII は射影しない** (一覧の PII 露出面を最小化、ルール4)。
 */
export type SchoolMember = Pick<
  InferSelectModel<typeof users>,
  "id" | "displayName" | "role" | "isActive"
>;

/**
 * F11 (#47 第2スライス / #320): 自校の教職員一覧を返す。**SELECT のみ**。
 *
 * 学校管理者 (school_admin) が自校の教職員 (school_admin / teacher) を一覧し、誰のロールを管理できるか
 * を把握するための read 層。PR #318 では並行レーン #289 (本ファイル新規追加) との衝突回避のため
 * apps/web に inline していたが、#317 land 後に本ファイルへ**昇格**し、専用の実 PG RLS テストで
 * テナント分離を直接証明する (#318 Reviewer Low-1)。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `WHERE school_id` を書かない — 可視範囲は `users` の RLS (`tenant_isolation`) が決める。呼出側は
 * `withSession` / `withTenantContext` 済み (school_admin context、自校 school_id) の `tx` を渡すこと。
 * 自校外のメンバーは 0 行に倒れる。`role IN (教職員)` は**対象絞り込み**で、テナント境界の手書き WHERE
 * ではない (RLS のバイパスではない) — student / guardian は対象外なので除外し PII 露出を最小化する。
 *
 * ## 並び
 * 稼働中 (is_active) を先頭に、ロール昇順 (enum 定義順: school_admin → teacher) → 表示名昇順で決定的に
 * する。無効化済みアカウントも末尾に残し、過去在籍のトレース用に閲覧できるようにする。
 */
export async function listSchoolMembers(tx: TenantTx): Promise<SchoolMember[]> {
  return await tx
    .select({
      id: users.id,
      displayName: users.displayName,
      role: users.role,
      isActive: users.isActive,
    })
    .from(users)
    .where(inArray(users.role, [...STAFF_ROLES]))
    .orderBy(desc(users.isActive), asc(users.role), asc(users.displayName));
}
