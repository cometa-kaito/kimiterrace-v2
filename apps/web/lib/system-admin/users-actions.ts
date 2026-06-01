"use server";

import { type TenantRole, type TenantTx, auditLog, users } from "@kimiterrace/db";
import { createLogger } from "@kimiterrace/observability";
import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { changeIdpUserRole, deactivateIdpUser, reactivateIdpUser } from "../auth/admin-mutations";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { type ActionResult, conflict, forbidden, invalid, isUuid, notFound } from "./schools-core";

/** この画面が扱う教職員ロール (school_admin ↔ teacher の相互変更)。student/guardian/system_admin は対象外。 */
const STAFF_ROLES = ["school_admin", "teacher"] as const;
type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * mirror tx 内の FOR UPDATE 再カウントで last-admin レース (#355 Low-2) を検出したとき投げる番兵。
 * これを投げると mirror tx (DB mirror + 監査) がロールバックされ、caller が IdP の revoke を補償して
 * `conflict` を返す。`Error` サブクラスにして他の DB エラー (`update affected no row` 等) と区別する。
 */
class LastAdminRaceError extends Error {
  constructor() {
    super("last-admin guard race detected at mirror tx (#355)");
    this.name = "LastAdminRaceError";
  }
}

/**
 * DB トリガ (#395 L2 / migration 0015) の「各校に有効 school_admin >= 1」不変条件違反を表す
 * カスタム SQLSTATE。アプリ層の FOR UPDATE 再カウント (#392) を**バイパスする経路**で last-admin を
 * 取り除こうとしたとき、トリガがこのコードで RAISE する。正常系 (本 seam 経由) ではアプリ側ガードが
 * 先に `LastAdminRaceError` を投げて UPDATE に到達しないため、このコードは通常出ない (= 多層防御)。
 */
const LAST_ADMIN_INVARIANT_SQLSTATE = "KT001";

/**
 * drizzle が wrap した PostgreSQL エラーの SQLSTATE を取り出す。drizzle は元の pg エラーを
 * DrizzleQueryError でラップし SQLSTATE は `.cause.code` 側に入るため、top-level と cause の両方を見る
 * (schools-actions.ts と同規律)。
 */
function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  if (e && typeof e.code === "string") {
    return e.code;
  }
  if (e?.cause && typeof e.cause.code === "string") {
    return e.cause.code;
  }
  return undefined;
}

/**
 * mirror tx の失敗が last-admin ロックアウト防止に由来するか。アプリ層 FOR UPDATE 再カウントの番兵
 * (#355) と、それを越えた DB トリガ (#395 L2) の不変条件違反の**両方**を同じ補償パスに合流させる。
 */
function isLastAdminRace(error: unknown): boolean {
  return (
    error instanceof LastAdminRaceError || pgErrorCode(error) === LAST_ADMIN_INVARIANT_SQLSTATE
  );
}

/**
 * 構造化ロガー (#395 L1 / NFR04, ADR-026 L1 観測性)。
 *
 * last-admin TOCTOU レース (#355 Low-2) 検出時、mirror tx は **監査 insert の前にロールバック**するため、
 * 実行された「IdP revoke → 補償 (reactivate / role 復元)」の往復が `audit_log` に残らない。net DB state は
 * 不変 (対象は元の active / school_admin のまま) で ADR-026 L1 (system_admin の同定はアプリ/IdP ログ側) とも
 * 整合するが、**確定実行された IdP の往復は観測したい**。そこで race パスで 1 件 `warn` を出す。
 *
 * PII は載せない (ルール4 / NFR03): user_id / school_id は UUID であり個人情報ではない。structured payload は
 * `@kimiterrace/observability` 側で redact されるが (defense-in-depth)、ID のみで PII を渡さない規律を守る。
 */
const logger = createLogger("system-admin-users");

/**
 * F11 (#47 / #324, ADR-026): system_admin が **全校横断**で教職員のアカウントを無効化 / 再有効化する
 * Server Action。`/admin/system/users` (#343) の各行から呼ぶ。
 *
 * #336 の自校版 (`setMemberActiveAction`、school_admin → 自校 teacher) に対する **system_admin 版**で、
 * 任意校の school_admin / teacher を対象にできる。エンフォースは #336 と同じ IdP seam
 * (`deactivateIdpUser` = disable + `revokeRefreshTokens` / `reactivateIdpUser` = enable) を再利用する
 * (ADR-026: IdP が認証エンフォースの単一ソース、DB の `is_active` は mirror)。
 *
 * ## 実行順 (ADR-026: IdP を先に、DB mirror を後に)
 * 1. 入力検証 → `requireRole(SYSTEM_ADMIN_ROLES)` (school_admin / teacher は 403)。
 * 2. RLS tx (system_admin context) で対象の現ロール / 状態 / 所属校を読む (`system_admin_full_access`
 *    で全校可視。自校外でも読める)。教職員以外 (student/guardian、IdP アカウント無し) は対象外。
 * 3. **last-admin ガード (ADR-026 / ロックアウト防止)**: 対象が **その学校で最後の有効な school_admin**
 *    なら無効化を拒否する (学校が管理者ゼロになるのを防ぐ)。
 * 4. **IdP 更新を先に** (失効を確定)。
 * 5. 成功後に DB `users.is_active` mirror 更新 + `audit_log` を同一 tx で記録 (ルール1)。
 *
 * ## 監査 (ルール1 / NFR04)
 * `users` はテナントスコープなので `audit_log.school_id` は **対象の所属校** を記録する (audit_log_insert
 * policy は system_admin context で任意 school_id を許可)。actor は **system_admin は `users` 行でない**ため
 * `actor_user_id` / `created_by` / `updated_by` を NULL とする (advertisers と同じ cross-tenant actor 規律、
 * system_admin の同定はアプリ/IdP セッションログ側)。
 */
export async function setStaffActiveAction(raw: {
  userId?: unknown;
  isActive?: unknown;
}): Promise<ActionResult<{ id: string; isActive: boolean }>> {
  if (!isUuid(raw.userId)) {
    return invalid("ユーザーの指定が不正です。");
  }
  if (typeof raw.isActive !== "boolean") {
    return invalid("状態の指定が不正です。");
  }
  const userId = raw.userId;
  const nextActive = raw.isActive;

  await requireRole(SYSTEM_ADMIN_ROLES);

  // 1) RLS tx: 対象の現ロール / 状態 / 所属校を読み、教職員限定 + last-admin ガードを評価する
  //    (IdP 呼び出しを跨がない短い read)。
  const gate = await withGate(userId, nextActive);

  if (gate.kind === "not_found") {
    return notFound("指定されたユーザーが見つかりません。");
  }
  if (gate.kind === "not_staff") {
    // 一覧は教職員のみを出すため通常到達しない。生徒/保護者は IdP アカウントを持たない (対象外)。
    return forbidden("教職員以外のアカウントはこの画面では操作できません。");
  }
  if (gate.kind === "last_admin") {
    return conflict(
      "この学校で唯一の有効な学校管理者のため無効化できません。先に別の学校管理者を有効化してください。",
    );
  }

  // 2) IdP 更新を先に (ADR-026)。失効はここで確定する。
  if (nextActive) {
    await reactivateIdpUser(userId);
  } else {
    await deactivateIdpUser(userId);
  }

  // この無効化が「有効な school_admin を 1 人減らす」操作か。gate (lock 無し count) は通過済みだが、
  // 同一校の最後の 2 名を 2 つの system_admin が同時に無効化する TOCTOU レース (#355 Low-2) は、
  // mirror tx 内の FOR UPDATE 再カウントでしか直列検出できない。再有効化はロックアウトを起こさないため対象外。
  const removesActiveAdmin = !nextActive && gate.role === "school_admin" && gate.wasActive;

  // 3) DB mirror + 監査を同一 tx で。テナント監査なので school_id は対象校、actor は system_admin ゆえ NULL。
  try {
    await withSession(
      async (tx) => {
        // TOCTOU 根治 (#355 Low-2): 管理者を減らす無効化のみ、FOR UPDATE 再カウントで last-admin を
        // 直列検出する。最後の 1 人なら番兵を投げて tx をロールバックする (UPDATE / 監査に到達しない)。
        if (removesActiveAdmin && (await lockAndCountActiveSchoolAdmins(tx, gate.schoolId)) <= 1) {
          throw new LastAdminRaceError();
        }
        const updated = await tx
          .update(users)
          // updated_at は auditColumns では INSERT 時のみ default のため UPDATE では明示更新する (ルール1)。
          .set({ isActive: nextActive, updatedBy: null, updatedAt: new Date() })
          .where(eq(users.id, userId))
          .returning({ id: users.id });
        if (updated.length === 0) {
          // 多層防御: read が通って UPDATE 0 行 = RLS 越境 (本来到達しない)。IdP は既に更新済 (安全側)。
          throw new Error("user is_active mirror update affected no row");
        }
        await tx.insert(auditLog).values({
          actorUserId: null,
          schoolId: gate.schoolId,
          tableName: "users",
          recordId: userId,
          operation: "update",
          diff: { before: { isActive: gate.wasActive }, after: { isActive: nextActive } },
          rowHash: "",
          createdBy: null,
          updatedBy: null,
        });
      },
      { allowedRoles: SYSTEM_ADMIN_ROLES },
    );
  } catch (e) {
    if (isLastAdminRace(e)) {
      // #395 L1: race パスは mirror tx ロールバックで audit_log に残らないため、確定実行された IdP の往復
      // (revoke→補償) を構造化ログで 1 件記録する (NFR04 観測性, ADR-026 L1)。補償**前**に出すことで、
      // 補償が二重障害で失敗しても「レース検出 + IdP revoke 確定」のイベントは残る。
      // detectedBy=db_trigger_kt001 は本 seam の FOR UPDATE 再カウントを越えてトリガ (#395 L2) が
      // 弾いたことを示す = seam バイパス経路の異常シグナル (通常は app_recount)。
      logger.warn(
        {
          event: "last_admin_race_detected",
          action: "deactivate",
          detectedBy: e instanceof LastAdminRaceError ? "app_recount" : "db_trigger_kt001",
          schoolId: gate.schoolId,
          targetUserId: userId,
          compensation: "reactivate_idp_user",
        },
        "last-admin race detected at mirror tx; compensating IdP-first deactivation",
      );
      // 補償 (ADR-026 IdP-first ゆえ revoke は確定済): IdP を再有効化して巻き戻す。DB は未更新 = 元から
      // active のまま。これで「学校が管理者ゼロ」を防ぐ。再有効化も失敗する二重障害は loud に投げて手動復旧へ。
      await reactivateIdpUser(userId);
      return conflict(
        "この学校で唯一の有効な学校管理者のため無効化できません。先に別の学校管理者を有効化してください。",
      );
    }
    throw e;
  }

  revalidatePath("/admin/system/users");
  return { ok: true, data: { id: userId, isActive: nextActive } };
}

type GateResult =
  | { kind: "not_found" }
  | { kind: "not_staff" }
  | { kind: "last_admin" }
  // role / wasActive は mirror tx の TOCTOU 再カウント要否 (有効な school_admin を減らす操作か) の判定に使う。
  | { kind: "ok"; schoolId: string; role: StaffRole; wasActive: boolean };

/**
 * 対象ユーザーの現状態を読み、教職員限定 + last-admin ガードを評価して判定を返す。read のみの短い tx。
 */
async function withGate(userId: string, nextActive: boolean): Promise<GateResult> {
  return await withSession(
    async (tx: TenantTx) => {
      const [row] = await tx
        .select({ role: users.role, isActive: users.isActive, schoolId: users.schoolId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) {
        return { kind: "not_found" } as const;
      }
      if (row.role !== "school_admin" && row.role !== "teacher") {
        return { kind: "not_staff" } as const;
      }
      // last-admin ガード: 有効な school_admin を無効化しようとしていて、その人が学校で唯一の有効な
      // 管理者なら拒否する (再有効化や teacher は対象外、既に無効なら lockout リスク無しで対象外)。
      if (!nextActive && row.role === "school_admin" && row.isActive) {
        if ((await countActiveSchoolAdmins(tx, row.schoolId)) <= 1) {
          return { kind: "last_admin" } as const;
        }
      }
      return {
        kind: "ok",
        schoolId: row.schoolId,
        role: row.role,
        wasActive: row.isActive,
      } as const;
    },
    { allowedRoles: SYSTEM_ADMIN_ROLES },
  );
}

/**
 * 指定校の **有効な (is_active) school_admin** の数を数える。last-admin ガード (無効化 / 降格) の単一ソース。
 * system_admin context (`system_admin_full_access`) で対象校をまたいで数える。
 */
async function countActiveSchoolAdmins(tx: TenantTx, schoolId: string): Promise<number> {
  const [c] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(eq(users.schoolId, schoolId), eq(users.role, "school_admin"), eq(users.isActive, true)),
    );
  return c?.n ?? 0;
}

/**
 * 指定校の有効な school_admin を **行ロック (FOR UPDATE)** して数える。last-admin ガードの TOCTOU
 * レース根治 (#355 Low-2)。
 *
 * gate (lock 無しの `countActiveSchoolAdmins`) と DB mirror UPDATE は **別トランザクション**で、間に IdP
 * 往復を挟む (ADR-026 IdP-first ゆえ行ロックを跨げない)。そのため同一校の最後の 2 名の school_admin を
 * 2 つの system_admin が同時に無効化/降格すると、両者とも gate で count=2 を見て通過し学校が管理者ゼロに
 * なりうる。mirror tx 内でこの関数を呼ぶと、対象校の有効 school_admin 行を FOR UPDATE でロックする。
 * 先行 tx が commit した後、後続 tx はロック解放時に行を再評価し (READ COMMITTED の EvalPlanQual)、既に
 * 無効化/降格された管理者を `is_active = true` / `role = school_admin` 条件から除外して数えるため、最後の
 * 1 人を確実に直列検出できる。
 *
 * 注: `count(*)` は集約のため `FOR UPDATE` と併用できない (PG エラー)。行 id を FOR UPDATE で取得して
 * JS 側で数える。
 */
async function lockAndCountActiveSchoolAdmins(tx: TenantTx, schoolId: string): Promise<number> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.schoolId, schoolId), eq(users.role, "school_admin"), eq(users.isActive, true)),
    )
    .for("update");
  return rows.length;
}

/**
 * F11 (#47 / #324, ADR-026 D2): system_admin が教職員の **ロールを変更** する Server Action
 * (school_admin ↔ teacher)。`/admin/system/users` (#343) の各行から呼ぶ。
 *
 * エンフォースは IdP seam `changeIdpUserRole` (`setCustomUserClaims` + `revokeRefreshTokens`) を使う
 * (ADR-026 D2: claims がロールの単一ソース。revoke で再ログインを強制し、**降格で旧特権 claim が残る**のを
 * 防ぐ)。DB の `users.role` は mirror。**DB-only のロール変更は作らない** (D3)。
 *
 * ## 実行順 (ADR-026: IdP を先に、DB mirror を後に)
 * 1. 入力検証 (nextRole は school_admin / teacher のみ) → `requireRole(SYSTEM_ADMIN_ROLES)`。
 * 2. RLS tx で対象の現ロール / 状態 / 所属校を読む。教職員以外は対象外、現ロールと同じなら no-op。
 * 3. **降格 last-admin ガード**: 有効な school_admin を teacher に降格しようとしていて、その人が学校で
 *    唯一の有効な管理者なら拒否する (無効化と同じロックアウト防止、ADR-026)。
 * 4. **IdP 更新を先に** (claims 再付与 + revoke)。
 * 5. 成功後に DB `users.role` mirror 更新 + `audit_log` を同一 tx で記録 (ルール1)。
 *
 * 監査は無効化と同じ規律: テナント監査ゆえ `school_id` = 対象校、actor は system_admin ゆえ NULL。
 */
export async function changeStaffRoleAction(raw: {
  userId?: unknown;
  nextRole?: unknown;
}): Promise<ActionResult<{ id: string; role: StaffRole }>> {
  if (!isUuid(raw.userId)) {
    return invalid("ユーザーの指定が不正です。");
  }
  if (raw.nextRole !== "school_admin" && raw.nextRole !== "teacher") {
    return invalid("変更先のロールが不正です。");
  }
  const userId = raw.userId;
  const nextRole = raw.nextRole;

  await requireRole(SYSTEM_ADMIN_ROLES);

  // 1) RLS tx: 対象の現ロール / 状態 / 所属校を読み、教職員限定 + 降格 last-admin ガードを評価する。
  const gate = await withRoleGate(userId, nextRole);

  if (gate.kind === "not_found") {
    return notFound("指定されたユーザーが見つかりません。");
  }
  if (gate.kind === "not_staff") {
    return forbidden("教職員以外のアカウントはこの画面では操作できません。");
  }
  if (gate.kind === "no_change") {
    return invalid("ロールに変更がありません。");
  }
  if (gate.kind === "last_admin") {
    return conflict(
      "この学校で唯一の有効な学校管理者のため教員に変更できません。先に別の学校管理者を用意してください。",
    );
  }

  // 2) IdP 更新を先に (claims 再付与 + revoke で再ログイン強制)。
  await changeIdpUserRole(userId, nextRole, gate.schoolId);

  // この降格が「有効な school_admin を 1 人減らす」操作か。降格も無効化と同じ last-admin レース
  // (#355 Low-2) を起こす。昇格 (teacher→school_admin) は管理者を減らさないため対象外。
  const removesActiveAdmin =
    nextRole === "teacher" && gate.before === "school_admin" && gate.wasActive;

  // 3) DB mirror + 監査を同一 tx で。
  try {
    await withSession(
      async (tx) => {
        // TOCTOU 根治 (#355 Low-2): 管理者を減らす降格のみ、FOR UPDATE 再カウントで last-admin を直列検出。
        if (removesActiveAdmin && (await lockAndCountActiveSchoolAdmins(tx, gate.schoolId)) <= 1) {
          throw new LastAdminRaceError();
        }
        const updated = await tx
          .update(users)
          .set({ role: nextRole, updatedBy: null, updatedAt: new Date() })
          .where(eq(users.id, userId))
          .returning({ id: users.id });
        if (updated.length === 0) {
          throw new Error("user role mirror update affected no row");
        }
        await tx.insert(auditLog).values({
          actorUserId: null,
          schoolId: gate.schoolId,
          tableName: "users",
          recordId: userId,
          operation: "update",
          diff: { before: { role: gate.before }, after: { role: nextRole } },
          rowHash: "",
          createdBy: null,
          updatedBy: null,
        });
      },
      { allowedRoles: SYSTEM_ADMIN_ROLES },
    );
  } catch (e) {
    if (isLastAdminRace(e)) {
      // #395 L1: race パスは mirror tx ロールバックで audit_log に残らないため、確定実行された IdP の往復
      // (降格→補償) を構造化ログで 1 件記録する (NFR04 観測性, ADR-026 L1)。補償**前**に出す。
      // detectedBy=db_trigger_kt001 は seam の FOR UPDATE 再カウントを越えてトリガ (#395 L2) が弾いた異常シグナル。
      logger.warn(
        {
          event: "last_admin_race_detected",
          action: "change_role",
          detectedBy: e instanceof LastAdminRaceError ? "app_recount" : "db_trigger_kt001",
          schoolId: gate.schoolId,
          targetUserId: userId,
          compensation: "restore_school_admin_role",
        },
        "last-admin race detected at mirror tx; compensating IdP-first demotion",
      );
      // 補償: IdP のロールを school_admin に戻す (revoke 済のため再ログインは要るが claim は復元)。DB は未更新。
      await changeIdpUserRole(userId, "school_admin", gate.schoolId);
      return conflict(
        "この学校で唯一の有効な学校管理者のため教員に変更できません。先に別の学校管理者を用意してください。",
      );
    }
    throw e;
  }

  revalidatePath("/admin/system/users");
  return { ok: true, data: { id: userId, role: nextRole } };
}

type RoleGateResult =
  | { kind: "not_found" }
  | { kind: "not_staff" }
  | { kind: "no_change" }
  | { kind: "last_admin" }
  // wasActive は mirror tx の TOCTOU 再カウント要否 (有効な school_admin を降格する操作か) の判定に使う。
  | { kind: "ok"; schoolId: string; before: TenantRole; wasActive: boolean };

/**
 * ロール変更の対象を読み、教職員限定 / no-op / 降格 last-admin ガードを評価して判定を返す。read のみの短い tx。
 */
async function withRoleGate(userId: string, nextRole: StaffRole): Promise<RoleGateResult> {
  return await withSession(
    async (tx: TenantTx) => {
      const [row] = await tx
        .select({ role: users.role, isActive: users.isActive, schoolId: users.schoolId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!row) {
        return { kind: "not_found" } as const;
      }
      if (row.role !== "school_admin" && row.role !== "teacher") {
        return { kind: "not_staff" } as const;
      }
      if (row.role === nextRole) {
        return { kind: "no_change" } as const;
      }
      // 降格 last-admin ガード: 有効な school_admin を teacher に降格しようとしていて、その人が学校で
      // 唯一の有効な管理者なら拒否する (無効化と同じロックアウト防止。昇格 teacher→school_admin は対象外)。
      if (row.role === "school_admin" && nextRole === "teacher" && row.isActive) {
        if ((await countActiveSchoolAdmins(tx, row.schoolId)) <= 1) {
          return { kind: "last_admin" } as const;
        }
      }
      return {
        kind: "ok",
        schoolId: row.schoolId,
        before: row.role,
        wasActive: row.isActive,
      } as const;
    },
    { allowedRoles: SYSTEM_ADMIN_ROLES },
  );
}
