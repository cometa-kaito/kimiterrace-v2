"use server";

import {
  type TenantTx,
  auditLog,
  findVisibleClass,
  getClassConfigValue,
  upsertClassConfig,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  type ActionResult,
  EDITOR_ROLES,
  type EditorActor,
  conflict,
  forbidden,
  invalid,
  isUuid,
  toEditorActor,
} from "../editor/schedule-core";
import { parseBlackout } from "./blackout";

/**
 * サイネージ「黒画面」トグルの Server Action（per-class・web のみ・APK / migration 不要、ADR-008 —
 * 画面 mutation は Server Actions）。指定クラスの `school_configs`（scope='class', kind='display_settings'）
 * の `value.blackout` を upsert する。`true` で教室サイネージが全画面の黒画面に切り替わり（実機 SignageClient
 * が payload.blackout を見て描画）、`false` で通常の盤面に戻る（ポーリングで反映）。
 *
 * 操作: 入力検証 → 認可（`requireRole(EDITOR_ROLES)` = teacher / school_admin）→ actor 解決 →
 * `withSession({ tenantScoped: true })` の自校 RLS tx 内で **自校可視性チェック**（cross-tenant 防御）→
 * **1 (school, class, display_settings) = 1 行の upsert** + `audit_log` 追記 → `revalidatePath`。
 * `school_configs` は手書き WHERE school_id を持たず、RLS（`tenant_isolation`）が自校を強制する（ルール2）。
 *
 * **display_settings 行の相乗り（衝突しない設計）**: 同 kind の **scope='school'** 行は学校レベル既定デザイン
 * （`signageDesign`）を持つが、本 Action が触るのは **scope='class'** の別行（`ux_school_configs_target` の
 * 別エントリ）。`blackout` だけを書き、既存の他キーは持たない単一目的の value にする。
 *
 * **多層防御（cross-tenant 整合, Issue #73 / quiet-hours-actions と同作法）**: `classId` は書き込み前に
 * **自校で可視か RLS 経由で確認**してから結線する（`findVisibleClass`）。他校 class_id を渡しても
 * 「不可視 → not found」で弾かれ、別テナントのクラスに黒画面設定をぶら下げられない。
 *
 * **system_admin の降格（ADR-019 §#95 / Issue #226）**: 特定 class（= 特定 school）を対象にする
 * テナントスコープ操作のため `tenantScoped: true` で実行し、`system_admin_full_access` policy の全校発火を
 * 止める（quiet-hours-actions と同種の gap 封じ）。
 */

/** 親参照（class）が自校で不可視のとき tx をロールバックさせる内部エラー（cross-tenant 防止）。 */
class CrossTenantError extends Error {}

/** PostgreSQL の unique / check 制約違反（SQLSTATE 23505 / 23514）。並行 upsert や制約違反など。 */
function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code: unknown }).code;
  return code === "23505" || code === "23514";
}

/** audit_log に 1 行追記（ルール1 / NFR04）。prev_hash/row_hash は BEFORE INSERT トリガが計算。 */
async function writeAudit(
  tx: TenantTx,
  actor: EditorActor,
  params: { recordId: string; operation: "insert" | "update"; before: boolean; after: boolean },
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actor.userId,
    schoolId: actor.schoolId,
    tableName: "school_configs",
    recordId: params.recordId,
    operation: params.operation,
    // 黒画面は PII を含まない真偽値。insert は after のみ、update は before/after を残す。
    diff:
      params.operation === "insert"
        ? { after: { blackout: params.after } }
        : { before: { blackout: params.before }, after: { blackout: params.after } },
    rowHash: "",
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });
}

/**
 * 指定クラスのサイネージ黒画面を ON/OFF する（upsert）。実教室の画面に即時影響するため、UI 側は押下時に
 * 確認ダイアログを挟む（本 Action 自体は冪等な真偽値書き込み）。
 *
 * @param classId  対象クラス UUID（自校で可視なもの）。
 * @param blackout `true` = 黒画面にする / `false` = 解除して盤面に戻す。
 */
export async function setClassSignageBlackoutAction(
  classId: unknown,
  blackout: unknown,
): Promise<ActionResult<{ blackout: boolean }>> {
  if (!isUuid(classId)) {
    return invalid("クラスの指定が不正です。");
  }
  if (typeof blackout !== "boolean") {
    return invalid("黒画面の指定が不正です。");
  }

  const user = await requireRole(EDITOR_ROLES);
  const actor = toEditorActor(user);
  if (!actor) {
    return forbidden("学校に属さないユーザーは編集できません。");
  }

  try {
    const saved = await withSession(
      async (tx) => {
        // 対象クラスが自校で可視か（他校 id は RLS で不可視 → CrossTenantError）。
        if (!(await findVisibleClass(tx, classId))) {
          throw new CrossTenantError("編集対象のクラスが見つかりません。");
        }
        // upsert 前に既存値を読み、insert/update の別と before スナップショットを確定する。
        const prevValue = await getClassConfigValue(tx, classId, "display_settings");
        const operation: "insert" | "update" = prevValue === null ? "insert" : "update";
        const before = parseBlackout(prevValue);

        const id = await upsertClassConfig(tx, {
          schoolId: actor.schoolId,
          classId,
          kind: "display_settings",
          value: { blackout },
          actorUserId: actor.userId,
        });
        if (!id) {
          throw new CrossTenantError("黒画面の設定を保存できませんでした。");
        }

        await writeAudit(tx, actor, { recordId: id, operation, before, after: blackout });
        return blackout;
      },
      { tenantScoped: true },
    );

    // エディタのプレビュー導線を即時反映（実機は自前のポーリングで false/true 復帰を拾う）。
    revalidatePath(`/app/editor/${classId}`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { blackout: saved } };
  } catch (error) {
    if (error instanceof CrossTenantError) {
      return invalid(error.message);
    }
    if (isConstraintViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
