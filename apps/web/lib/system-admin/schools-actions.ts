"use server";

import {
  type TenantTx,
  auditLog,
  createSchool,
  deleteSchool,
  getSchool,
  updateSchool,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import {
  type ActionResult,
  conflict,
  invalid,
  isUuid,
  notFound,
  validateSchoolCreate,
  validateSchoolUpdate,
} from "./schools-core";

/**
 * #48-L (#123): システム管理者の学校編集 Server Action (ADR-008 — 画面 mutation は Server Actions)。
 *
 * V1 `updateSchool` + `setSchoolHierarchyMode` 相当を 1 アクションに統合する (基本フィールド +
 * 階層モードの全置換)。一覧 + 編集 (update) のみが本スライス (#48-L1) のスコープ。詳細ビュー
 * (V1 SchoolDetailView) は #48-L2、create/delete (テナント プロビジョニング) は follow-up に切り出す。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)` で school_admin / teacher を 403。
 * 横断 (全校) マスタの編集は system_admin 専用。
 *
 * **横断 RLS (ADR-019 / ルール2)**: system_admin は schoolId=null で `withSession` に入り、
 * `withTenantContext` が `app.current_user_role='system_admin'` のみ SET する (school スコープは張らない)。
 * schools の `system_admin_full_access` policy が全校 SELECT/UPDATE を grant するため、本アクションは
 * `WHERE school_id` を**手書きしない** — 越権防止は RLS に委ねる。万一 school_admin がここを通っても
 * (実際は 403 で弾かれる) `tenant_isolation_modify` で自校のみに制限される。
 *
 * **監査 (ルール1)**: 編集を同一 tx で audit_log に追記する。system_admin は `users` 行ではないため
 * `actor_user_id` / `created_by` / `updated_by` は NULL とする (FK は users(id)、#110 policy が
 * system_admin context の NULL actor を許可)。`school_id` には**対象校 id** を記録し追跡可能にする
 * (system_admin context では任意 school_id が許可される、0005 policy)。
 */

/**
 * drizzle が wrap した PostgreSQL エラーの SQLSTATE を取り出す。drizzle は元の pg エラーを
 * DrizzleQueryError ("Failed query: …") でラップし、SQLSTATE は `.cause.code` 側に入るため、
 * top-level と cause の両方を見る (top-level だけだと取りこぼす)。
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

/** PostgreSQL の unique 制約違反 (SQLSTATE 23505)。学校コード重複など。 */
function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23505";
}

/** PostgreSQL の FK 制約違反 (SQLSTATE 23503)。子データが残る学校の削除など。 */
function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23503";
}

/** 対象校が RLS で不可視 (他校 / 不存在) のとき tx をロールバックさせる。 */
class SchoolNotFoundError extends Error {}

/**
 * 学校の基本フィールド (name / prefecture / code) + 階層モードを更新する。
 *
 * 全置換: UI から来た現在値で上書きする (省略フィールドを null 化する事故を避ける、hub update と同方針)。
 * 対象校は更新前に `getSchool` で再取得し、不可視 (他校 / 不存在) は `not_found`。同名/コード衝突 (23505)
 * は `conflict`。
 */
export async function updateSchoolAction(raw: {
  id?: unknown;
  name?: unknown;
  prefecture?: unknown;
  code?: unknown;
  hierarchyMode?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateSchoolUpdate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  // 認可: system_admin のみ。redirect 副作用 (未認証→/login, 権限不足→/forbidden) はここで起きる。
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const before = await getSchool(tx, v.value.id);
      if (!before) {
        throw new SchoolNotFoundError();
      }
      const updated = await updateSchool(tx, v.value.id, {
        name: v.value.name,
        prefecture: v.value.prefecture,
        code: v.value.code,
        hierarchyMode: v.value.hierarchyMode,
        // system_admin は users 行ではないため updated_by は NULL (FK は users(id))。
        updatedBy: user.role === "system_admin" ? null : user.uid,
      });
      if (updated.length === 0) {
        // RLS で UPDATE が 0 行 (再取得後に可視性が変わる等の競合) → not_found に倒す。
        throw new SchoolNotFoundError();
      }
      await writeSchoolAudit(tx, user, v.value.id, "update", {
        before: {
          name: before.name,
          prefecture: before.prefecture,
          code: before.code,
          hierarchyMode: before.hierarchyMode,
        },
        after: {
          name: v.value.name,
          prefecture: v.value.prefecture,
          code: v.value.code,
          hierarchyMode: v.value.hierarchyMode,
        },
      });
      return { id: v.value.id };
    });
    revalidatePath("/admin/system/schools");
    revalidatePath(`/admin/system/schools/${v.value.id}/edit`);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SchoolNotFoundError) {
      return notFound("指定された学校が見つかりません。");
    }
    if (isUniqueViolation(error)) {
      return conflict("同じ学校コードが既に存在します。");
    }
    throw error;
  }
}

/**
 * 学校 (テナント) を新規作成する (#48-L3 — テナント プロビジョニング)。
 *
 * 認可は `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin 限定)。INSERT は schools の
 * `system_admin_full_access` WITH CHECK でのみ通る (テナントは INSERT policy 不在で RLS 拒否)。
 * 作成と監査を同一 tx で行い、成功後に新規校の id を返す。学校コード重複 (23505) は `conflict`。
 */
export async function createSchoolAction(raw: {
  name?: unknown;
  prefecture?: unknown;
  code?: unknown;
  hierarchyMode?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  const v = validateSchoolCreate(raw);
  if (!v.ok) {
    return invalid(v.message);
  }
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const [row] = await createSchool(tx, {
        name: v.value.name,
        prefecture: v.value.prefecture,
        code: v.value.code,
        hierarchyMode: v.value.hierarchyMode,
        // system_admin は users 行ではないため created_by は NULL (FK は users(id))。
        createdBy: user.role === "system_admin" ? null : user.uid,
      });
      if (!row) {
        // INSERT が 0 行 = RLS で WITH CHECK 不成立 (本来 403 で来ないが多層防御)。
        throw new SchoolNotFoundError();
      }
      await writeSchoolAudit(tx, user, row.id, "insert", { after: v.value });
      return { id: row.id };
    });
    revalidatePath("/admin/system/schools");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SchoolNotFoundError) {
      return notFound("学校を作成できませんでした。");
    }
    if (isUniqueViolation(error)) {
      return conflict("同じ学校コードが既に存在します。");
    }
    throw error;
  }
}

/**
 * 学校 (テナント) を削除する (#48-L4)。**空の学校のみ削除可** — テナント所有の子データ (学年/クラス/学科/
 * コンテンツ/ユーザー等) が残る学校は FK RESTRICT で DB が削除を拒否し (23503)、`conflict` に写像する
 * (soft-delete を導入せず hard-delete を安全側に倒す、ルール2)。
 *
 * **cross-tenant 例外**: `feedback` は school_id が非テナントキーの任意参照で `ON DELETE SET NULL`
 * (schema/feedback.ts)。feedback だけを持つ学校は「空校」として削除でき、feedback 行 (PII 含む) は
 * school_id=NULL で生存し system_admin の閲覧対象に残る (deleteSchool の doc 参照、#239 Reviewer H-1)。
 *
 * 認可は `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin 限定)。削除と監査を同一 tx で行い、FK 違反時は
 * tx がロールバックされ監査も残らない。`audit_log.school_id` は FK ではないため作成時監査行は削除を阻まない。
 */
export async function deleteSchoolAction(raw: { id?: unknown }): Promise<
  ActionResult<{ id: string }>
> {
  if (!isUuid(raw.id)) {
    return invalid("学校の指定が不正です。");
  }
  const id = raw.id;
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx: TenantTx, user) => {
      const before = await getSchool(tx, id);
      if (!before) {
        throw new SchoolNotFoundError();
      }
      const deleted = await deleteSchool(tx, id);
      if (deleted.length === 0) {
        throw new SchoolNotFoundError();
      }
      await writeSchoolAudit(tx, user, id, "delete", {
        // hard-delete は不可逆。漏洩/係争時の「削除前に何があったか」を立証できるよう、削除前
        // スナップショットは getSchool が返す編集対象カラムを全て含める (notes 欠落を防ぐ、#246 Low-1)。
        before: {
          name: before.name,
          prefecture: before.prefecture,
          code: before.code,
          hierarchyMode: before.hierarchyMode,
          notes: before.notes,
        },
      });
      return { id };
    });
    // 一覧に加え、削除済みの詳細/編集ページのキャッシュも purge する。次アクセスは getSchoolDetail /
    // getSchool が 0 行 → notFound() に倒れ、消えた学校の stale ページを返さない (#246 Low-3)。
    revalidatePath("/admin/system/schools");
    revalidatePath(`/admin/system/schools/${id}`);
    revalidatePath(`/admin/system/schools/${id}/edit`);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SchoolNotFoundError) {
      return notFound("指定された学校が見つかりません。");
    }
    if (isForeignKeyViolation(error)) {
      return conflict(
        "学年・クラス・コンテンツ等の関連データが存在するため削除できません。先に配下データを削除してください。",
      );
    }
    throw error;
  }
}

/**
 * audit_log に 1 行追記 (ルール1 / NFR04)。prev_hash/row_hash は BEFORE INSERT トリガが計算。
 * system_admin は users 行ではないため actor 系は NULL、school_id には対象校 id を記録する。
 */
async function writeSchoolAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  schoolId: string,
  operation: "insert" | "update" | "delete",
  diff: unknown,
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    schoolId,
    tableName: "schools",
    recordId: schoolId,
    operation,
    diff: diff as object,
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}
