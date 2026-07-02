"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { previousBusinessDay } from "../signage/rotation";
import {
  EditorTargetNotFoundError,
  isUniqueViolation,
  upsertDailySectionForTarget,
} from "./daily-data-write";
import { getClassAssignments, getClassNotices } from "./notice-assignment-queries";
import {
  type ActionResult,
  DAILY_DATA_EDITOR_ROLES,
  conflict,
  forbidden,
  invalid,
  isValidDate,
  parseEditorTarget,
  toScopedEditorActor,
} from "./schedule-core";
import { getClassSchedule } from "./schedule-queries";

/**
 * 前日コピー（F3・editor-input-tiers-and-signage-paging.md §7）。指定クラスの**前営業日**
 * （{@link previousBusinessDay}・盤面の「次の N 平日」と同じ土日スキップロジックの後ろ向き版）の
 * 予定 / 連絡 / 提出物 を、対象日へ**置換保存で複製**する。
 *
 * - 認可（`requireRole`）→ 自校 RLS tx（`tenantScoped`）内で前営業日を読み、対象日の 3 セクションを
 *   `upsertDailySectionForTarget` で上書き（各エディタの保存と同一コア＝検証済み typed items・監査 created_by/
 *   updated_by = 操作教員 = actor・RLS/cross-tenant 防止を共有）。
 * - **前営業日に 3 セクションとも空**なら複製しない（対象日を誤って空に置換しない安全弁＝invalid で戻す）。
 * - 対象日に既存入力がある場合の**上書き確認はクライアント側**（`CopyPreviousDayButton` の confirm）。本 action は
 *   常に置換する（呼ぶ側が確認済みの前提）。
 *
 * 3 セクションを 1 tx でまとめて書くので部分適用が起きない（全て成功 or 例外で全ロールバック）。
 */
export async function copyPreviousDayAction(
  classId: unknown,
  date: unknown,
): Promise<
  ActionResult<{
    fromDate: string;
    counts: { schedules: number; notices: number; assignments: number };
  }>
> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  if (!isValidDate(date)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
  }
  const fromDate = previousBusinessDay(date);
  if (!fromDate) {
    return invalid("前営業日を計算できませんでした。");
  }

  const user = await requireRole(DAILY_DATA_EDITOR_ROLES);
  const actor = toScopedEditorActor(user);
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーは編集できません。",
    );
  }

  try {
    const result = await withSession(
      async (tx) => {
        // 前営業日の 3 セクションを自校 RLS 下で読む。クラス不可視（別テナント / 不存在）は null。
        const schedule = await getClassSchedule(tx, target.classId, fromDate);
        if (!schedule) {
          return { kind: "not_found" as const };
        }
        const notices = await getClassNotices(tx, target.classId, fromDate);
        const assignments = await getClassAssignments(tx, target.classId, fromDate);
        const sch = schedule.items;
        const not = notices?.items ?? [];
        const asg = assignments?.items ?? [];
        if (sch.length === 0 && not.length === 0 && asg.length === 0) {
          return { kind: "empty" as const };
        }
        // 前営業日の各セクションを対象日へ置換保存（監査 = 操作教員 = actor）。3 セクション同一 tx。
        await upsertDailySectionForTarget(tx, actor, target, date, "schedules", sch);
        await upsertDailySectionForTarget(tx, actor, target, date, "notices", not);
        await upsertDailySectionForTarget(tx, actor, target, date, "assignments", asg);
        return {
          kind: "ok" as const,
          counts: { schedules: sch.length, notices: not.length, assignments: asg.length },
        };
      },
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    if (result.kind === "not_found") {
      return invalid("クラスが見つかりません。");
    }
    if (result.kind === "empty") {
      return invalid(`前営業日（${fromDate}）に複製できる予定・連絡・提出物がありません。`);
    }
    revalidatePath(`/app/editor/${target.classId}`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { fromDate, counts: result.counts } };
  } catch (error) {
    if (error instanceof EditorTargetNotFoundError) {
      return invalid("編集対象が見つかりません。");
    }
    if (isUniqueViolation(error)) {
      return conflict("他の操作と競合しました。最新の内容を読み込み直してください。");
    }
    throw error;
  }
}
