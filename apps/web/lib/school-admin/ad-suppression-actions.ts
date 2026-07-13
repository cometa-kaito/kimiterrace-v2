"use server";

import { type TenantTx, auditLog, schoolConfigs, upsertScopeConfig } from "@kimiterrace/db";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { isPgErrorCode } from "../pg-error";
import {
  AD_SUPPRESSION_KEY,
  type AdSuppressionConfig,
  parseAdSuppression,
  validateAdSuppression,
} from "../signage/ad-suppression";
import {
  type ActionResult,
  type HubActor,
  SCHOOL_HIERARCHY_ROLES,
  conflict,
  forbidden,
  invalid,
  toHubActor,
} from "./hub-core";

/**
 * 学校スコープ「授業時間中の広告停止（adSuppression）」の Server Action（ADR-008 — 画面 mutation は
 * Server Actions）。システム管理者が学校の画面（`/ops/schools/{id}/ad-suppression`）で授業時間帯を設定し、
 * 自校 `school_configs`（scope='school', kind='display_settings'）の `value.adSuppression` を upsert する。
 *
 * 操作: 入力検証 → 認可（`requireRole(SCHOOL_HIERARCHY_ROLES)` + `toHubActor`）→
 * `withSession({ tenantScoped: true, schoolId })` の対象校 RLS tx 内で **display_settings 行を FOR UPDATE で
 * ロック → 相乗りキー保全マージ upsert** + `audit_log` 追記 → `revalidatePath`。手書き WHERE school_id は
 * 持たず RLS（`tenant_isolation`）が対象校を強制する（ルール2）。
 *
 * **既存キーの保全（マージ upsert・#1264 と同作法）**: display_settings 行には `signageDesign` /
 * `assignmentDeadlineFormat` / `editorDayCutover` / `blackout` が相乗りしている。upsert は value 全置換のため、
 * FOR UPDATE で読んだ既存 value をスプレッドし `adSuppression` キーだけ差し替える（他キーを消さない・
 * read-merge-write レースは行ロックで直列化）。
 *
 * **system_admin の対象校スコープ + 降格（quiet-hours / display-settings と同型）**: `toHubActor` は
 * system_admin に `targetSchoolId` を要求し（未指定は null → forbidden）、`userRef=null`（users 行なし＝
 * created_by/updated_by の FK 回避）・`identityUid=uid`（監査に残す）を返す。`tenantScoped: true` で
 * system_admin を school_admin に降格し `system_admin_full_access` policy の全校発火を止め、他校 display_settings
 * を不可視にする（越境防止）。
 */

/** 学校スコープの ScopeColumns（scope='school' は全 id NULL・ck_school_configs_scope 充足）。 */
const SCHOOL_TARGET = {
  scope: "school",
  gradeId: null,
  departmentId: null,
  classId: null,
} as const;

/** 保存不能時に tx をロールバックさせる内部エラー。 */
class SaveFailedError extends Error {}

/** PostgreSQL の unique / check 制約違反（SQLSTATE 23505 / 23514）。並行 upsert など。 */
function isConstraintViolation(error: unknown): boolean {
  return isPgErrorCode(error, "23505", "23514");
}

/**
 * 自校の display_settings 行の `value` を **FOR UPDATE で行ロック**して読む（display-settings-actions の
 * `lockDisplaySettingsValue` と同作法）。read-merge-write の更新ロストを防ぐ（#1264）。行が無ければ null。
 * school_id は RLS で自校（＝対象校）に限定（ルール2・手書き WHERE school_id は書かない）。
 */
async function lockDisplaySettingsValue(tx: TenantTx): Promise<unknown | null> {
  const [row] = await tx
    .select({ value: schoolConfigs.value })
    .from(schoolConfigs)
    .where(and(eq(schoolConfigs.scope, "school"), eq(schoolConfigs.kind, "display_settings")))
    .limit(1)
    .for("update");
  return row ? row.value : null;
}

/** 監査 diff 用の要約。時刻・曜日・日付のみで PII を含まない。 */
function auditView(cfg: AdSuppressionConfig): Record<string, unknown> {
  return {
    adSuppression: {
      enabled: cfg.enabled,
      variations: cfg.variations.map((v) => ({ name: v.name, rangeCount: v.ranges.length })),
      weekdayMap: cfg.weekdayMap,
      overrideCount: Object.keys(cfg.overrides).length,
      overrides: cfg.overrides,
    },
  };
}

/** audit_log に 1 行追記（ルール1 / NFR04）。prev_hash/row_hash は BEFORE INSERT トリガが計算。 */
async function writeAudit(
  tx: TenantTx,
  actor: HubActor,
  params: {
    recordId: string;
    operation: "insert" | "update";
    before: AdSuppressionConfig;
    after: AdSuppressionConfig;
  },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName: "school_configs",
    recordId: params.recordId,
    operation: params.operation,
    diff:
      params.operation === "insert"
        ? { after: auditView(params.after) }
        : { before: auditView(params.before), after: auditView(params.after) },
    rowHash: "",
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 授業時間中の広告停止設定を保存する（upsert）。`enabled=false` / 割り当て無しで「停止しない」に更新できる。
 *
 * @param rawTargetSchoolId 対象校 id（system_admin /ops 経路で必須）。school_admin は無視され自校に固定。
 * @param rawEnabled 機能の有効/無効（boolean）。
 * @param rawVariations 時間割バリエーション（`[{ key, name, ranges:[{start,end}] }]`）。
 * @param rawWeekdayMap 曜日ごとの割り当て（`{ "1": key, ... }`・値はバリエーション key or "__none__"）。
 * @param rawOverrides  特定日の割り当て（`{ "YYYY-MM-DD": key, ... }`・値は key or "__none__"）。
 */
export async function saveAdSuppressionAction(
  rawTargetSchoolId: unknown,
  rawEnabled: unknown,
  rawVariations: unknown,
  rawWeekdayMap: unknown,
  rawOverrides: unknown,
): Promise<ActionResult<{ id: string }>> {
  const v = validateAdSuppression(rawEnabled, rawVariations, rawWeekdayMap, rawOverrides);
  if (!v.ok) {
    return invalid(v.message);
  }

  const user = await requireRole(SCHOOL_HIERARCHY_ROLES);
  const actor = toHubActor(
    user,
    typeof rawTargetSchoolId === "string" ? rawTargetSchoolId : undefined,
  );
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーは授業時間を設定できません。",
    );
  }

  try {
    const id = await withSession(
      async (tx) => {
        // FOR UPDATE で既存 value を読み、(1) insert/update の別と before スナップショット、(2) 相乗りキー
        // （signageDesign / blackout 等）を保全するマージ基底、を確定する（並行 read-merge-write を直列化）。
        const prev = await lockDisplaySettingsValue(tx);
        const operation: "insert" | "update" = prev === null ? "insert" : "update";
        const before = parseAdSuppression(prev);
        const base =
          prev && typeof prev === "object" && !Array.isArray(prev)
            ? (prev as Record<string, unknown>)
            : {};

        const newId = await upsertScopeConfig(tx, {
          schoolId: actor.schoolId,
          target: SCHOOL_TARGET,
          kind: "display_settings",
          value: { ...base, [AD_SUPPRESSION_KEY]: v.value },
          // created_by / updated_by は users.id への FK。system_admin は null（FK 回避、userRef）。
          actorUserId: actor.userRef,
        });
        if (!newId) {
          throw new SaveFailedError("授業時間設定を保存できませんでした。");
        }

        await writeAudit(tx, actor, { recordId: newId, operation, before, after: v.value });
        return newId;
      },
      // tenantScoped: system_admin を school_admin に降格し full_access policy の全校発火を止める（越境防止）。
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    // 運営の設定画面と教員向けプレビュー導線を即時反映。実機サイネージは自前ポーリングで追従する。
    revalidatePath(`/ops/schools/${actor.schoolId}/ad-suppression`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { id } };
  } catch (error) {
    if (error instanceof SaveFailedError) {
      return invalid(error.message);
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
