import { type InferSelectModel, and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../client.js";
import { schoolConfigs } from "../schema/school-configs.js";
import type { ScopeColumns } from "./ads.js";

/**
 * 学校設定 (`school_configs`) の読み取り / upsert クエリ層 (#48-J-2)。
 *
 * **RLS (ルール2)**: すべて `withSession` の自校コンテキスト tx 内で呼ぶ。`school_configs` の
 * SELECT / INSERT / UPDATE は `app.current_school_id` で自校に限定される (手書き WHERE school_id は
 * 書かない、DB レベルで強制)。別テナントの行は不可視 → not found 扱い。
 *
 * **型 (ルール3)**: 行型は schema の `schoolConfigs` テーブルから `InferSelectModel` で派生する
 * (手書き interface を作らない)。`scope` / `kind` の値域は `hierarchy_scope` / `config_kind` enum と
 * 単一ソースになる (schema 経由)。
 *
 * 本ファイルは **1 (school, scope ターゲット, kind) = 1 行** の upsert を担う。`ux_school_configs_target`
 * (NULLS NOT DISTINCT) により scope ごとの一意性が DB レベルで保証される。クラス設定 (#48-J-2) では
 * scope='class' + class_id + kind='quiet_hours' の 1 行を読み書きする。
 */

/** `school_configs` テーブルの 1 行。schema 由来 (単一ソース)。 */
export type SchoolConfig = InferSelectModel<typeof schoolConfigs>;

/** `kind` の値域 (config_kind enum 由来)。 */
export type ConfigKind = SchoolConfig["kind"];

/**
 * 指定クラス・指定 kind の設定 1 行の `value` を取得する。
 * 行が無ければ (未設定 / 別テナントで不可視) null。
 */
export async function getClassConfigValue(
  tx: TenantTx,
  classId: string,
  kind: ConfigKind,
): Promise<unknown | null> {
  const [row] = await tx
    .select({ value: schoolConfigs.value })
    .from(schoolConfigs)
    .where(
      and(
        eq(schoolConfigs.scope, "class"),
        eq(schoolConfigs.classId, classId),
        eq(schoolConfigs.kind, kind),
      ),
    )
    .limit(1);
  return row ? row.value : null;
}

/**
 * 指定クラス・指定 kind の設定を upsert する (1 行 = 1 (school, class, kind))。
 *
 * `ux_school_configs_target` (school_id, scope, grade_id, department_id, class_id, kind / NULLS NOT
 * DISTINCT) を競合キーに `onConflictDoUpdate` で value を差し替える。INSERT / UPDATE いずれの分岐でも
 * RLS の WITH CHECK / USING が自校を強制する (school_id は actor 由来、手書きの他校書き込みは不可)。
 *
 * @returns upsert 後の行 id (audit_log の record_id に使う)。
 */
export async function upsertClassConfig(
  tx: TenantTx,
  params: {
    schoolId: string;
    classId: string;
    kind: ConfigKind;
    value: object;
    actorUserId: string;
  },
): Promise<string | null> {
  const [row] = await tx
    .insert(schoolConfigs)
    .values({
      schoolId: params.schoolId,
      scope: "class",
      classId: params.classId,
      kind: params.kind,
      value: params.value,
      createdBy: params.actorUserId,
      updatedBy: params.actorUserId,
    })
    .onConflictDoUpdate({
      // NULLS NOT DISTINCT の複合一意制約に合わせ、全ターゲット列を target に列挙する。
      target: [
        schoolConfigs.schoolId,
        schoolConfigs.scope,
        schoolConfigs.gradeId,
        schoolConfigs.departmentId,
        schoolConfigs.classId,
        schoolConfigs.kind,
      ],
      set: {
        value: params.value,
        updatedBy: params.actorUserId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schoolConfigs.id });
  return row?.id ?? null;
}

/**
 * 指定 kind の **学校スコープ** (scope='school') 設定 1 行の `value` を取得する。
 * 行が無ければ (未設定 / 別テナントで不可視) null。school_id は RLS (app.current_school_id) で
 * 自校に限定されるため引数に取らない (ルール2、手書き WHERE school_id は書かない)。
 * scope='school' の行は ck_school_configs_scope により grade/class/department が NULL で、
 * ux_school_configs_target (NULLS NOT DISTINCT) で (school, 'school', kind) が一意。
 */
export async function getSchoolConfigValue(
  tx: TenantTx,
  kind: ConfigKind,
): Promise<unknown | null> {
  const [row] = await tx
    .select({ value: schoolConfigs.value })
    .from(schoolConfigs)
    .where(and(eq(schoolConfigs.scope, "school"), eq(schoolConfigs.kind, kind)))
    .limit(1);
  return row ? row.value : null;
}

/**
 * 指定 kind の **学校スコープ** 設定を upsert する (1 行 = 1 (school, scope='school', kind))。
 * grade/class/department は NULL (ck_school_configs_scope)。競合キー・RLS 強制は {@link upsertClassConfig}
 * と同一。
 *
 * @returns upsert 後の行 id (audit_log の record_id に使う)。
 */
export async function upsertSchoolConfig(
  tx: TenantTx,
  params: {
    schoolId: string;
    kind: ConfigKind;
    value: object;
    actorUserId: string;
  },
): Promise<string | null> {
  const [row] = await tx
    .insert(schoolConfigs)
    .values({
      schoolId: params.schoolId,
      scope: "school",
      kind: params.kind,
      value: params.value,
      createdBy: params.actorUserId,
      updatedBy: params.actorUserId,
    })
    .onConflictDoUpdate({
      target: [
        schoolConfigs.schoolId,
        schoolConfigs.scope,
        schoolConfigs.gradeId,
        schoolConfigs.departmentId,
        schoolConfigs.classId,
        schoolConfigs.kind,
      ],
      set: {
        value: params.value,
        updatedBy: params.actorUserId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schoolConfigs.id });
  return row?.id ?? null;
}

/** scope + 3 つの id 列を null 安全に突き合わせる WHERE (1 ターゲット = 1 設定行を選ぶ)。 */
function configScopeWhere(t: ScopeColumns) {
  return and(
    eq(schoolConfigs.scope, t.scope),
    t.gradeId === null ? isNull(schoolConfigs.gradeId) : eq(schoolConfigs.gradeId, t.gradeId),
    t.departmentId === null
      ? isNull(schoolConfigs.departmentId)
      : eq(schoolConfigs.departmentId, t.departmentId),
    t.classId === null ? isNull(schoolConfigs.classId) : eq(schoolConfigs.classId, t.classId),
  );
}

/**
 * 指定スコープ (school/department/grade/class)・指定 kind の設定 1 行の `value` を取得する。
 * 行が無ければ null。{@link getClassConfigValue} / {@link getSchoolConfigValue} の scope 汎用版。
 * `target` は app 層の `targetIdColumns(EditorTarget)` の出力 (scope と id 列が ck を充足)。
 */
export async function getScopeConfigValue(
  tx: TenantTx,
  target: ScopeColumns,
  kind: ConfigKind,
): Promise<unknown | null> {
  const [row] = await tx
    .select({ value: schoolConfigs.value })
    .from(schoolConfigs)
    .where(and(configScopeWhere(target), eq(schoolConfigs.kind, kind)))
    .limit(1);
  return row ? row.value : null;
}

/**
 * 指定スコープ・指定 kind の設定を upsert する (1 行 = 1 (school, scope ターゲット, kind))。
 * {@link upsertClassConfig} / {@link upsertSchoolConfig} の scope 汎用版。競合キー・RLS 強制は同一。
 * scope と grade/department/class_id 列は `target` (targetIdColumns 由来) から設定し ck を充足する。
 *
 * `actorUserId` は `created_by` / `updated_by` (どちらも `users.id` への FK) に入る値で、
 * **null を許容**する。system_admin は `users` 表に行を持たないため、運営が特定校を編集する経路
 * (/ops/schools/[id]/quiet-hours/[classId]) では null を渡し FK 違反 (23503) を回避する
 * (audit_log 側で actor_identity_uid に IdP uid を残す)。school_admin は自身の users.id を渡す。
 *
 * @returns upsert 後の行 id (audit_log の record_id に使う)。
 */
export async function upsertScopeConfig(
  tx: TenantTx,
  params: {
    schoolId: string;
    target: ScopeColumns;
    kind: ConfigKind;
    value: object;
    actorUserId: string | null;
  },
): Promise<string | null> {
  const [row] = await tx
    .insert(schoolConfigs)
    .values({
      schoolId: params.schoolId,
      scope: params.target.scope,
      gradeId: params.target.gradeId,
      departmentId: params.target.departmentId,
      classId: params.target.classId,
      kind: params.kind,
      value: params.value,
      createdBy: params.actorUserId,
      updatedBy: params.actorUserId,
    })
    .onConflictDoUpdate({
      target: [
        schoolConfigs.schoolId,
        schoolConfigs.scope,
        schoolConfigs.gradeId,
        schoolConfigs.departmentId,
        schoolConfigs.classId,
        schoolConfigs.kind,
      ],
      set: {
        value: params.value,
        updatedBy: params.actorUserId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schoolConfigs.id });
  return row?.id ?? null;
}
