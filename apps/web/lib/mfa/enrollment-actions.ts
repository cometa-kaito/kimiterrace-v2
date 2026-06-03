"use server";

import { type TenantTx, auditLog } from "@kimiterrace/db";
import { getEnrolledMfaFactorCount } from "../auth/mfa-admin";
import { requireRole } from "../auth/guard";
import type { AuthUser } from "../auth/session";
import { withUserSession } from "../db";
import { type ActionResult, invalid } from "../system-admin/schools-core";
import { MFA_REQUIRED_ROLES } from "./policy";

/**
 * F11 (#47, ADR-031): **自分の MFA enrollment / unenrollment を `audit_log` に記録する** Server Action。
 *
 * ## 役割分担 (なぜ enroll/unenroll 自体はここでやらないか)
 * 第2要素の **登録 (enroll) / 解除 (unenroll) は Identity Platform の client SDK** で行う
 * (`multiFactor(user).enroll/unenroll`、ADR-003: claims を持つ操作は client SDK が標準)。サーバーの
 * Admin SDK は他人の MFA を勝手に登録する API を持たず、本人のクライアント操作が正規経路。よって本 Action
 * の責務は **enroll/unenroll を実行することではなく、その成否を監査に残すこと** (ルール1 / NFR04) +
 * 「自分の」操作であることの認可 (teacher 以上) に限定する。
 *
 * ## クライアントの自己申告を信用しない (監査の真実性)
 * クライアントは `enrolled`/件数を偽れる。監査の `diff` は **IdP から再読 (`getEnrolledMfaFactorCount`)**
 * した authoritative な件数で構成する (ADR-026 思想: IdP が単一ソース)。クライアントから渡るのは
 * 「enroll を試みたか unenroll を試みたか」の意図 (`op`) のみで、件数は信用しない。
 *
 * ## PII を監査に残さない (ルール4)
 * `MultiFactorInfo` は SMS factor の場合 `phoneNumber` を含みうる。本 Action は監査に **factor の件数のみ**を
 * 書き (`mfa-admin.ts` が件数へ縮約済み)、電話番号・factor uid・displayName 等は一切 `audit_log` に
 * 入れない。`record_id` も MFA factor を指さず **自分の所属表の行 id** にする (factor 識別子の漏洩回避)。
 *
 * ## 監査の対象表は actor の所属表で解決する (#544 Reviewer Low-1)
 * actor は `teacher`/`school_admin` なら `users` 行、`system_admin` なら **`system_admins` 行** (テナント外、
 * ADR-019: system_admin の単一の真実の源)。両者は別表なので `table_name`/`record_id` を一律 `users` に固定すると
 * system_admin の MFA 操作が `users` に存在しない id を指し**監査の意味的整合が崩れる** (record_id は FK 無し
 * nullable ゆえ実行時エラーにはならないが追跡不能になる)。`actor.role` で所属表を解決し `table_name` を出し分ける。
 *
 * ## 認可 / 越境
 * `requireRole(MFA_REQUIRED_ROLES)` で teacher 以上に限定 (生徒/保護者は対象外)。**actor = target = 自分**
 * 固定で、他人の uid を受け取らない (confused-deputy 防止)。uid は session の `requireRole` 戻り値から取り、
 * 外部入力を信用しない。監査は `withUserSession` (解決済み user で RLS context) に自テナントで書く。
 */
export async function recordMfaEnrollmentAudit(raw: {
  op?: unknown;
}): Promise<ActionResult<{ enrolledFactorCount: number }>> {
  // クライアントから来るのは「登録を試みた (enroll) / 解除を試みた (unenroll)」の意図のみ。件数は信用しない。
  if (raw.op !== "enroll" && raw.op !== "unenroll") {
    return invalid("MFA 操作の指定が不正です。");
  }
  const op = raw.op;

  // 認可: teacher 以上のみ (未認証→/login, 生徒/保護者→/forbidden の redirect 副作用)。
  // actor = target = この user (自分の MFA のみ)。uid は session 由来で外部入力を信用しない。
  const actor = await requireRole(MFA_REQUIRED_ROLES);

  // IdP から authoritative な登録件数を再読 (クライアント申告でなく単一ソース、ADR-026)。
  const enrolledFactorCount = await getEnrolledMfaFactorCount(actor.uid);

  await withUserSession(actor, async (tx) => {
    await writeMfaEnrollmentAudit(tx, actor, op, enrolledFactorCount);
  });

  return { ok: true, data: { enrolledFactorCount } };
}

/**
 * actor の所属表を返す (#544 Reviewer Low-1)。`system_admin` は `system_admins`、それ以外 (teacher /
 * school_admin) は `users`。MFA 監査の `record_id` (= 自分の id) がどの表の行を指すかを正しく出すため。
 */
function homeTableForActor(actor: AuthUser): "users" | "system_admins" {
  return actor.role === "system_admin" ? "system_admins" : "users";
}

/**
 * MFA enrollment / unenrollment を `audit_log` に追記する (ルール1 / NFR04)。prev_hash / row_hash は
 * BEFORE INSERT トリガが計算。actor = 自分、`record_id` = **自分の所属表 (users / system_admins) の行**
 * (factor 識別子は出さない)。所属表は `actor.role` で解決する (#544 Reviewer Low-1)。
 *
 * **PII を残さない (ルール4)**: `diff` は **件数と操作種別のみ**。電話番号・factor uid・QR/secret は
 * 一切含めない (件数縮約は `getEnrolledMfaFactorCount` 側で済んでいる)。
 */
async function writeMfaEnrollmentAudit(
  tx: TenantTx,
  actor: AuthUser,
  op: "enroll" | "unenroll",
  enrolledFactorCount: number,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.uid,
    // 自テナント操作。system_admin は school を持たない (null) ので user.schoolId をそのまま使う。
    schoolId: actor.schoolId,
    // actor の所属表 (system_admin→system_admins / それ以外→users) を指す。users 固定だと
    // system_admin の操作が存在しない users 行を指し監査が崩れる (#544 Reviewer Low-1)。
    tableName: homeTableForActor(actor),
    // factor を指さず自分の所属表の行を対象にする (factor uid/電話番号の漏洩回避、ルール4)。
    recordId: actor.uid,
    operation: "update",
    // PII を残さない: 操作種別と件数のみ (電話番号・factor 識別子は含めない)。
    diff: { mfa: { op, enrolledFactorCount } },
    rowHash: "",
    createdBy: actor.uid,
    updatedBy: actor.uid,
  });
}
