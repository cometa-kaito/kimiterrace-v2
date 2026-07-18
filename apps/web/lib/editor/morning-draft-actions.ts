"use server";

import { type SignageDesignPattern, resolveDesignPattern } from "@/lib/signage/design-pattern";
import { type SignageBlockKind, blockLabel } from "@/lib/signage/pattern-blocks";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import { type TenantTx, getClassSignageUrl } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import {
  EditorTargetNotFoundError,
  isUniqueViolation,
  upsertDailySectionForTarget,
} from "./daily-data-write";
import { getEditorDayEvents } from "./day-events-queries";
import { buildMorningDraft } from "./morning-draft-core";
import { validateNoticeItems } from "./notice-assignment-core";
import { getClassAssignments, getClassNotices } from "./notice-assignment-queries";
import {
  type ActionResult,
  DAILY_DATA_EDITOR_ROLES,
  type EditorTarget,
  type ScopedEditorActor,
  conflict,
  forbidden,
  invalid,
  isValidDate,
  parseEditorTarget,
  toScopedEditorActor,
  validateScheduleItems,
} from "./schedule-core";
import { getClassName, getClassSchedule } from "./schedule-queries";
import { getClassWeeklyTimetable } from "./weekly-timetable-queries";

/**
 * P0「朝ドラフト」の**確定 Server Action**（editor-shipping-and-zero-input-2026-07.md §3.1・PR-Z2）。
 *
 * ゾーン1 の「今日の下書きができています」カード（PR-Z3）から呼ぶ 1 クリック確定。`buildMorningDraft`（PR-Z1）
 * が組んだ表示合成を daily_data へ **materialize** する。前日/前週コピー（`copyDayFromAction` 系）と**同じ作法**
 * で書く: 書込前に対象日のスナップショット（undo 用）→ 対象セクションを 1 tx で
 * {@link upsertDailySectionForTarget} → 戻り値に `undo`（DaySnapshot 互換）同梱 → client は
 * `restoreCopySnapshotAction` で「元に戻す」。
 *
 * ## 決定事項（§3.1）
 * - **D1: 自動保存しない**。本 action は教員の明示 1 クリックでのみ走る（保存＝即盤面公開のため）。
 * - **D4: 確定はサーバで再合成**。client が組んだ items は信用せず、`{classId, date, excluded}` だけ受け取り、
 *   サーバで素材（実効パターン・現 daily_data・基本時間割・年間行事）を読み直して `buildMorningDraft` を
 *   **再実行**する（`restoreCopySnapshotAction` の fail-closed 再検証をより強くした形）。
 * - 保存前に合成結果を既存バリデータ（{@link validateScheduleItems} / {@link validateNoticeItems}）へ通す
 *   （`upsertDailySectionForTarget` は無検証で書くため・防御）。1 つでも不正なら**何も書かず**全体を拒否する
 *   （検証は tx 内・失敗は kind を返して全ロールバック＝部分適用ゼロ）。
 *
 * 注: `toScopedEditorActor(user)` を targetSchoolId 無しで呼ぶため **system_admin は常に forbidden**
 * （fail-closed・コピー系と同判断＝朝ドラフトは教員の日常操作で /ops 横断経路は不要）。
 */

/** 確定した 1 セクション（成功トースト用・パターン別ラベルと件数）。`"use server"` は型を export できない。 */
type ConfirmedSection = { block: SignageBlockKind; label: string; count: number };

/**
 * コピー undo と構造互換のスナップショット（`restoreCopySnapshotAction` が受ける形＝`{date, schedule?, notice?}`）。
 * 朝ドラフトは予定 / 連絡しか書かないので、書いたセクションの**書込前 raw**（空セクションのみ合成するため実質
 * 空配列）だけを控える。client は CopyUndoContext に載せて「元に戻す」で復元する。
 */
type MorningDraftUndo = { date: string; schedule?: unknown[]; notice?: unknown[] };

/**
 * クラスの実効デザインパターンを tx 内で解決する（**端末別 `?design` > 学校レベル既定 > pattern1**。盤面
 * page.tsx / コピー系 action と同一の二段解決＝合成対象が「その端末が実際に表示するパターン」と一致する）。
 */
async function resolveClassPattern(tx: TenantTx, classId: string): Promise<SignageDesignPattern> {
  const schoolDefault = await getSignageDesignPattern(tx);
  const liveSignageUrl = await getClassSignageUrl(tx, classId);
  return resolveDesignPattern(liveSignageUrl, schoolDefault);
}

/** tx 内の確定結果（`withSession` コールバックの戻り）。 */
type ConfirmTxResult =
  | { kind: "not_found" }
  | { kind: "empty" }
  | { kind: "invalid_items"; message: string }
  | { kind: "ok"; sections: ConfirmedSection[]; undo: MorningDraftUndo };

/**
 * 朝ドラフトを確定して盤面へ出す。`date` の空セクションに合成した予定 / 連絡を daily_data へ置換保存する。
 * `excluded` は教員がカードで × した合成項目の安定キー（`buildMorningDraft` の `MorningDraftItemKey`）。
 *
 * 成功時は確定した各セクションの件数（トースト用）と `undo`（元に戻す用スナップショット）を返す。合成結果が
 * 空（既に入力済み / 休日で行事なし / 全除外）なら `invalid`。
 */
export async function confirmMorningDraftAction(
  classId: unknown,
  date: unknown,
  excluded: unknown,
): Promise<ActionResult<{ date: string; sections: ConfirmedSection[]; undo: MorningDraftUndo }>> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  if (!isValidDate(date)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
  }
  // 除外キーは string の配列のみ受ける（それ以外は無視＝除外なし扱い）。
  const excludedKeys = Array.isArray(excluded)
    ? excluded.filter((k): k is string => typeof k === "string")
    : [];

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
    const result = await withSession<ConfirmTxResult>(
      (tx) => confirmInTx(tx, actor, target, date, excludedKeys),
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    if (result.kind === "not_found") {
      return invalid("クラスが見つかりません。");
    }
    if (result.kind === "empty") {
      return invalid("反映できる下書きがありません。");
    }
    if (result.kind === "invalid_items") {
      return invalid(result.message);
    }
    revalidatePath(`/app/editor/${target.classId}`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return {
      ok: true,
      data: { date: result.undo.date, sections: result.sections, undo: result.undo },
    };
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

/**
 * 確定の tx 内本体（{@link confirmMorningDraftAction} から呼ぶ）。素材をサーバで読み直して
 * `buildMorningDraft` を再実行（D4）→ 検証 → 対象セクションを置換保存 → undo（書込前 raw）を組む。全て 1 tx。
 */
async function confirmInTx(
  tx: TenantTx,
  actor: ScopedEditorActor,
  target: Extract<EditorTarget, { scope: "class" }>,
  date: string,
  excludedKeys: string[],
): Promise<ConfirmTxResult> {
  // クラス可視性（別テナント / 不存在は null）。schedule を持たないパターンでも成立するよう明示チェック。
  if ((await getClassName(tx, target.classId)) === null) {
    return { kind: "not_found" };
  }
  // 素材をサーバで読み直す（D4）。page.tsx の表示合成と同じ取得元＝同じ下書きを再現する。
  const pattern = await resolveClassPattern(tx, target.classId);
  const existingSchedules = (await getClassSchedule(tx, target.classId, date))?.items ?? [];
  const existingNotices = (await getClassNotices(tx, target.classId, date))?.items ?? [];
  const existingAssignments = (await getClassAssignments(tx, target.classId, date))?.items ?? [];
  const weeklyTimetable = (await getClassWeeklyTimetable(tx, target.classId))?.timetable ?? null;
  const dayEvents = await getEditorDayEvents(tx, actor.schoolId, date);

  const draft = buildMorningDraft({
    date,
    pattern,
    existing: {
      schedules: existingSchedules,
      notices: existingNotices,
      assignments: existingAssignments,
    },
    weeklyTimetable,
    dayEvents,
    excluded: excludedKeys,
  });
  if (draft.isEmpty) {
    return { kind: "empty" };
  }

  // 書込前スナップショット（undo）。空セクションのみ合成するので実質空配列だが、コピー系と同じく「書込前の
  // 状態」を控えて完全復元を保証する。書いたセクションだけ含める。
  const undo: MorningDraftUndo = { date };
  const sections: ConfirmedSection[] = [];

  // 保存前に合成結果を保存と同じバリデータへ通す（防御・失敗は全ロールバック）。
  if (draft.sections.schedules) {
    const v = validateScheduleItems(draft.sections.schedules.map((entry) => entry.item));
    if (!v.ok) {
      return { kind: "invalid_items", message: v.message };
    }
    undo.schedule = existingSchedules;
    await upsertDailySectionForTarget(tx, actor, target, date, "schedules", v.value);
    sections.push({
      block: "schedule",
      label: blockLabel(pattern, "schedule"),
      count: v.value.length,
    });
  }
  if (draft.sections.notices) {
    const v = validateNoticeItems(draft.sections.notices.map((entry) => entry.item));
    if (!v.ok) {
      return { kind: "invalid_items", message: v.message };
    }
    undo.notice = existingNotices;
    await upsertDailySectionForTarget(tx, actor, target, date, "notices", v.value);
    sections.push({ block: "notice", label: blockLabel(pattern, "notice"), count: v.value.length });
  }

  return { kind: "ok", sections, undo };
}
