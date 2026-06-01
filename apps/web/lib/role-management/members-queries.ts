import { type TenantRole, type TenantTx, users } from "@kimiterrace/db";
import { type InferSelectModel, asc, desc, inArray } from "drizzle-orm";

/**
 * F11 (#47 第2スライス): 自校メンバー (教員/管理者) の読み取り層。**サーバー専用**。
 *
 * 学校管理者 (school_admin) が自校に所属するユーザーを一覧し、誰のロールを管理できるかを把握する
 * ための read ビュー。ロールの付与/変更/無効化の判定は #275 の純粋ポリシー
 * (`lib/role-management/policy.ts`) が担い、本層はその対象となるユーザーの一覧を供給する。
 *
 * ## テナント分離 (CLAUDE.md ルール2)
 * `WHERE school_id` を手書きしない — 可視範囲は `users` の RLS (`tenant_isolation`) が決める。
 * 呼び出し側は `requireRole(["school_admin"])` + `withSession` (school_admin context、自校 school_id)
 * で RLS を満たすこと。**school_admin context では自校ユーザーのみ可視**になる。
 *
 * **スコープの明記 (正直に)**: 本ビューは **school_admin の自校運用専用**。system_admin の全校横断
 * ユーザー/ロール管理は `/admin/system/` 配下の別スライスで用意する (本層を system_admin context で
 * 呼ぶと `system_admin_full_access` が全校ユーザーを返してしまうため、ページ側で system_admin を
 * 403 に倒し、横断 PII を自校ビューに混ぜない。advertisers/dashboard と同じ per-surface スコープ方針)。
 *
 * ## 対象 (F11 スコープ = 教職員ロール)
 * F11 が扱うロールは system_admin / school_admin / teacher。本一覧は **自校の教職員ロール
 * (school_admin / teacher)** に絞る。生徒 (student) / 保護者 (guardian) はロール管理の対象外であり、
 * 一覧に出すと不要な PII 露出になるため `role IN (...)` で除外する (これはテナント境界ではなく対象
 * 絞り込み — RLS のバイパスではない、ルール2)。
 *
 * ## PII (ルール4 / NFR04)
 * 射影は **id / 表示名 / ロール / 稼働状態**のみ。`email` (PII) は本一覧では選択しない (詳細・操作系
 * スライスに回し、一覧の PII 露出面を最小化する)。表示名は自校の教職員を識別するための最小限で、
 * school_admin が自校メンバーを管理する正当な用途に閉じる。LLM へは送らない (ルール4 は対象外)。
 *
 * **クエリの置き場所**: 通常は `packages/db/src/queries/*` に置くが、本スライスは `apps/web` に inline
 * する。`packages/db` の `queries/users.ts` を新規追加中の並行レーン (#289 staff PII roster) との衝突を
 * 避けるためで、型は `users` スキーマ由来 (`InferSelectModel`) のままなので**単一ソースは維持**する
 * (ルール3)。並行レーン land 後に packages/db 側へ昇格してよい。
 */

/**
 * メンバー一覧 1 行の軽量射影。識別 + ロール + 稼働状態に絞る (email 等の PII は含めない)。
 */
export type SchoolMember = Pick<
  InferSelectModel<typeof users>,
  "id" | "displayName" | "role" | "isActive"
>;

/** F11 が扱う教職員ロール (一覧の対象)。student / guardian は除外する。 */
const STAFF_ROLES = ["school_admin", "teacher"] as const satisfies readonly TenantRole[];

/**
 * 自校の教職員一覧を返す。並びは**稼働中 (is_active) を先頭**に、ロール昇順 → 表示名昇順で決定的に
 * する (無効化済みアカウントも末尾に残し、過去在籍のトレース用に閲覧できるようにする)。
 *
 * `role IN (教職員)` は **対象絞り込み**で、テナント境界の手書き WHERE ではない — 自校/他校の境界は
 * RLS (`tenant_isolation`) が決め、自校外は 0 行に倒れる (ルール2)。
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
