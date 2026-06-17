"use server";

import { type TenantTx, auditLog, schoolConfigs } from "@kimiterrace/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { isPgErrorCode } from "../pg-error";
import { SYSTEM_ADMIN_ROLES } from "./roles";
import { parseConfigValueText } from "./school-config-core";
import { type ActionResult, conflict, invalid, isUuid, notFound } from "./schools-core";

/**
 * UIUX-03: システム管理者の学校設定 (school_configs) value 編集 Server Action
 * (ADR-008 — 画面 mutation は Server Actions)。
 *
 * **スコープ: 既存行の value (jsonb) 更新のみ**。新規作成・削除は提供しない —
 * `ck_school_configs_scope` (scope と grade/department/class_id の整合 CHECK) +
 * `ux_school_configs_target` (NULLS NOT DISTINCT 複合一意) の整合性制約が複雑で、横断 UI から
 * 誤った組合せの行を作る/消すリスクが高いため。行の新規作成は各スコープの編集 UI
 * (quiet-hours 等の upsert 経路、`upsertScopeConfig`) が担う。
 *
 * **認可 (system_admin 限定)**: `requireRole(SYSTEM_ADMIN_ROLES)`。横断 (全校) 設定の編集は
 * system_admin 専用 (schools-actions.ts と同作法)。
 *
 * **横断 RLS (ADR-019 / ルール2)**: `withSession` に `tenantScoped` を**渡さない** —
 * schools/[id]/edit の action (schools-actions.ts) と同じ作法。本 action は system_admin が
 * **任意校**の既存行を編集する横断経路で、降格すると `system_admin_full_access` policy が止まり
 * 全行不可視になる (tenantScoped は school_admin 等が「自校の特定対象」を書く経路用、
 * quiet-hours-actions.ts 参照)。万一 system_admin 以外がここを通っても (実際は 403 で弾かれる)
 * `tenant_isolation` policy が自校のみに制限する (多層防御)。
 *
 * **更新関数**: packages/db の既存クエリ (school-configs.ts) は scope ターゲット指定の upsert のみで
 * 「行 id 指定の value 更新」は無いため、`tx.update(schoolConfigs)` を直接使う
 * (packages/db は chokepoint のため編集しない)。updated_by / updated_at は既存 upsert
 * (`upsertScopeConfig`) の set と同じ作法で明示する。
 *
 * **監査 (ルール1)**: 更新と同一 tx で audit_log に追記する (quiet-hours-actions の writeAudit と
 * 同作法。audit_log の prev_hash/row_hash は BEFORE INSERT トリガが計算 → 空文字で渡す)。
 * system_admin は users 行ではないため actor_user_id / updated_by は NULL (FK は users(id))。
 * 代わりに `actorIdentityUid` へ IdP uid を載せ、操作者を特定可能にする (view-audit.ts と同方針 —
 * 監査ビューアで「システム」表示に落ちず実操作者が出る)。
 */

/** 対象行が RLS で不可視 (不存在) のとき tx をロールバックさせる内部エラー。 */
class ConfigNotFoundError extends Error {}

/** unique (23505) / check (23514) 制約違反。並行更新との競合等。cause 連鎖の解決は pg-error.ts。 */
function isConstraintViolation(error: unknown): boolean {
  return isPgErrorCode(error, "23505", "23514");
}

/** audit_log に 1 行追記 (ルール1 / NFR04)。モジュール doc「監査」参照。 */
async function writeConfigAudit(
  tx: TenantTx,
  user: { uid: string; role: string },
  params: { schoolId: string; recordId: string; diff: unknown },
): Promise<void> {
  const isSystemAdmin = user.role === "system_admin";
  await tx.insert(auditLog).values({
    actorUserId: isSystemAdmin ? null : user.uid,
    actorIdentityUid: user.uid,
    schoolId: params.schoolId,
    tableName: "school_configs",
    recordId: params.recordId,
    operation: "update",
    diff: params.diff as object,
    rowHash: "",
    createdBy: isSystemAdmin ? null : user.uid,
    updatedBy: isSystemAdmin ? null : user.uid,
  });
}

/**
 * 学校設定 1 行の value (jsonb) を更新する。`valueText` は textarea の JSON テキストで、
 * `parseConfigValueText` (school-config-core.ts) で検証する — パース不可・コンテナ以外は
 * `invalid` でメッセージを返し UI 側でインライン表示する (throw しない)。
 * 対象行は更新前に再取得し、不可視 (不存在) は `not_found`。制約競合 (23505/23514) は `conflict`。
 */
export async function updateSchoolConfigValueAction(raw: {
  id?: unknown;
  valueText?: unknown;
}): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(raw.id)) {
    return invalid("設定の指定が不正です。");
  }
  const id = raw.id;
  if (typeof raw.valueText !== "string") {
    return invalid("JSON を入力してください。");
  }
  const parsed = parseConfigValueText(raw.valueText);
  if (!parsed.ok) {
    return invalid(parsed.message);
  }
  // 認可: system_admin のみ。redirect 副作用 (未認証→/login, 権限不足→/forbidden) はここで起きる。
  await requireRole(SYSTEM_ADMIN_ROLES);

  try {
    const data = await withSession(async (tx, user) => {
      // 更新前スナップショット (監査 diff の before)。不可視 (RLS) / 不存在は not_found。
      const [before] = await tx
        .select({
          schoolId: schoolConfigs.schoolId,
          scope: schoolConfigs.scope,
          kind: schoolConfigs.kind,
          value: schoolConfigs.value,
        })
        .from(schoolConfigs)
        .where(eq(schoolConfigs.id, id))
        .limit(1);
      if (!before) {
        throw new ConfigNotFoundError();
      }
      const updated = await tx
        .update(schoolConfigs)
        .set({
          value: parsed.value,
          // system_admin は users 行ではないため updated_by は NULL (FK は users(id))。
          updatedBy: user.role === "system_admin" ? null : user.uid,
          updatedAt: new Date(),
        })
        .where(eq(schoolConfigs.id, id))
        .returning({ id: schoolConfigs.id });
      if (updated.length === 0) {
        // RLS で UPDATE が 0 行 (再取得後に可視性が変わる等の競合) → not_found に倒す。
        throw new ConfigNotFoundError();
      }
      await writeConfigAudit(tx, user, {
        schoolId: before.schoolId,
        recordId: id,
        // value は設定値 (時間帯・表示設定等) で生徒 PII を含まない設計 (school-config-list.ts 参照)。
        diff: {
          scope: before.scope,
          kind: before.kind,
          before: { value: before.value },
          after: { value: parsed.value },
        },
      });
      return { id };
    });
    revalidatePath("/ops/school-configs");
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      return notFound("指定された設定が見つかりません。削除された可能性があります。");
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
