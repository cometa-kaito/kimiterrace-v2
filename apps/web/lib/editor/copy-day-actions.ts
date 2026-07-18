"use server";

import { resolveDesignPattern } from "@/lib/signage/design-pattern";
import { getSignageDesignPattern } from "@/lib/signage/signage-design";
import {
  type SignageBlockKind,
  blockLabel,
  editableBlocksForPattern,
} from "@/lib/signage/pattern-blocks";
import {
  type ClassVisitorInput,
  type StudentCalloutInput,
  type TenantTx,
  auditLog,
  getCalloutsForClass,
  getClassSignageUrl,
  getVisitorsForClass,
  replaceClassVisitors,
  replaceStudentCallouts,
} from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { requireRole } from "../auth/guard";
import { withSession } from "../db";
import { jstDateString } from "../signage/rotation";
import {
  EditorTargetNotFoundError,
  isUniqueViolation,
  upsertDailySectionForTarget,
} from "./daily-data-write";
import { validateCalloutItems } from "./callouts-core";
import {
  copyableNoticeItems,
  validateAssignmentItems,
  validateNoticeItems,
} from "./notice-assignment-core";
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
import { validateVisitorItems } from "./visitors-core";
import { getClassName, getClassSchedule } from "./schedule-queries";
import { addDaysUtc, businessWeek, mondayOfWeek } from "./week-math";

/**
 * 前日 / 前週コピー（F3・C2）の Server Action 群 — **パターン動的化版**（editor-restructure-bulletin
 * -2026-07.md §6.4・v2-ed47-5 の根治）。
 *
 * 旧実装は常に 予定 / 連絡 / 提出物 の 3 セクション固定でコピーしていたため、pattern2/3（呼び出し / 来校者が
 * 実セクション）では「盤面に出るものがコピーされず、盤面に出ないものがコピーされる」不一致があった。本版は
 * tx 冒頭で**クラスの実効パターン**（端末別 `?design` > 学校既定 > pattern1・盤面 page.tsx / chat route と
 * 同一の二段解決）を解決し、コピー対象を単一ソース {@link editableBlocksForPattern} の実セクションに一致させる:
 * - daily_data 系（schedules / notices / assignments）は従来どおり {@link upsertDailySectionForTarget}
 *   （検証済み typed items・監査・RLS/cross-tenant 防止を各エディタの保存と共有）。
 * - **visitor / callout は実テーブルの日付行コピー**（`class_visitors.visit_date` / `student_callouts
 *   .callout_date` の対象日行を置換）。書込は既存の全置換コア {@link replaceClassVisitors} /
 *   {@link replaceStudentCallouts}（編集 Action と同一・RLS/cross-tenant 防止共有）＋同一 tx で audit_log
 *   追記（ルール1・visitors-actions / callouts-actions と同作法）。
 * - 「複製できるものが無い」「複製しました」の文言はコピー対象ブロックの**パターン別ラベル**
 *   （{@link blockLabel} §6.2・pattern5 なら「お知らせ・今日の予定」）で合成する。
 */

/**
 * コピー結果 1 セクション（表示ラベルはパターン別 blockLabel・件数は複製した行数）。
 * `"use server"` ファイルは async 関数しか export できない（Next の制約・他 action ファイルと同規律）ため
 * **export しない**。消費側（CopyFromMenu）は action の戻り型から構造的に推論する。
 */
type CopiedSection = { block: SignageBlockKind; label: string; count: number };

/**
 * クラスの実効デザインパターンを tx 内で解決する（**端末別 `?design` > 学校レベル既定 > pattern1**。
 * 盤面 page.tsx / AI chat route と同じ二段解決＝コピー対象が「その端末が実際に表示するパターン」と一致する）。
 */
async function resolveClassPattern(tx: TenantTx, classId: string) {
  const schoolDefault = await getSignageDesignPattern(tx);
  const liveSignageUrl = await getClassSignageUrl(tx, classId);
  return resolveDesignPattern(liveSignageUrl, schoolDefault);
}

/**
 * visitor / callout の実テーブル行コピーの監査（ルール1・visitors-actions の replaceAndAudit と同作法）。
 * 氏名そのものは diff に焼かず、対象クラス・日付・件数・複製元を残す（PII を監査ログに蓄積しすぎない）。
 */
async function auditRowCopy(
  tx: TenantTx,
  actor: ScopedEditorActor,
  tableName: "class_visitors" | "student_callouts",
  classId: string,
  date: string,
  fromDate: string,
  count: number,
): Promise<void> {
  await tx.insert(auditLog).values({
    // 操作者 uid は常に acting uid（daily-data-write の writeAudit と同規律）。
    actorUserId: actor.actorUserId,
    actorIdentityUid: actor.identityUid,
    schoolId: actor.schoolId,
    tableName,
    recordId: classId,
    operation: "update",
    diff: { date, count, copiedFrom: fromDate },
    rowHash: "",
    // created_by / updated_by は users.id への FK（本 action は system_admin を forbidden にするため非 null）。
    createdBy: actor.userRef,
    updatedBy: actor.userRef,
  });
}

/**
 * 複製元 1 日分の実セクション読み取り（{@link copyOneDay} の書込と `previewCopy*` の件数表示が共有する
 * 単一ソース）。読み取りは各ブロック 1 回＝空判定・件数・書込が同じスナップショット。notice は固定行
 * （pinned・§6.4・PR-C #1221）を除いた `copyableNoticeItems`（既に全日表示されており複製すると二重表示に
 * なるため対象外。区切り線 divider はレイアウトの一部なので含める）＝**プレビューに出す件数と実際に複製
 * される件数を一致させる**（「予定4」と出したのに 3 件しか入らない、を防ぐ）。
 */
type CopySource = {
  daily: Map<"schedule" | "notice" | "assignment", unknown[]>;
  visitors: Awaited<ReturnType<typeof getVisitorsForClass>>;
  callouts: Awaited<ReturnType<typeof getCalloutsForClass>>;
  countOf: (block: SignageBlockKind) => number;
  total: number;
};
async function readCopySource(
  tx: TenantTx,
  classId: string,
  blocks: readonly SignageBlockKind[],
  fromDate: string,
): Promise<CopySource> {
  const daily = new Map<"schedule" | "notice" | "assignment", unknown[]>();
  let visitors: Awaited<ReturnType<typeof getVisitorsForClass>> = [];
  let callouts: Awaited<ReturnType<typeof getCalloutsForClass>> = [];
  const counts = new Map<SignageBlockKind, number>();
  for (const block of blocks) {
    if (block === "schedule") {
      const items = (await getClassSchedule(tx, classId, fromDate))?.items ?? [];
      daily.set(block, items);
      counts.set(block, items.length);
    } else if (block === "notice") {
      const items = copyableNoticeItems(
        (await getClassNotices(tx, classId, fromDate))?.items ?? [],
      );
      daily.set(block, items);
      counts.set(block, items.length);
    } else if (block === "assignment") {
      const items = (await getClassAssignments(tx, classId, fromDate))?.items ?? [];
      daily.set(block, items);
      counts.set(block, items.length);
    } else if (block === "visitor") {
      visitors = await getVisitorsForClass(tx, classId, fromDate);
      counts.set(block, visitors.length);
    } else if (block === "callout") {
      callouts = await getCalloutsForClass(tx, classId, fromDate);
      counts.set(block, callouts.length);
    }
  }
  let total = 0;
  for (const n of counts.values()) {
    total += n;
  }
  return { daily, visitors, callouts, countOf: (b) => counts.get(b) ?? 0, total };
}

/**
 * コピー先 1 日分の**コピー前スナップショット**（undo「元に戻す」用）。コピーは対象ブロックを全置換するため、
 * 上書き前の対象日の内容をそのまま控える。**RAW で読む**（notice は固定行 pinned / 区切り divider も含む＝
 * `readCopySource` の copyable フィルタは使わない）＝復元で元通りにする。含むキーはコピーが触ったブロックだけ。
 * `"use server"` は型を export できないため、消費側（CopyFromMenu / restoreCopySnapshotAction）は構造推論する。
 * visitor / callout は保存コア（replace*）とバリデータ（validate*Items）が受ける Input 形へ写像して控える。
 */
type DaySnapshot = {
  date: string;
  schedule?: unknown[];
  notice?: unknown[];
  assignment?: unknown[];
  visitors?: unknown[];
  callouts?: unknown[];
};
async function readTargetRawSnapshot(
  tx: TenantTx,
  classId: string,
  blocks: readonly SignageBlockKind[],
  date: string,
): Promise<DaySnapshot> {
  const snap: DaySnapshot = { date };
  for (const block of blocks) {
    if (block === "schedule") {
      snap.schedule = (await getClassSchedule(tx, classId, date))?.items ?? [];
    } else if (block === "notice") {
      // RAW（固定行・区切り線も含む）で控える＝復元で元の掲示状態を完全に戻す。
      snap.notice = (await getClassNotices(tx, classId, date))?.items ?? [];
    } else if (block === "assignment") {
      snap.assignment = (await getClassAssignments(tx, classId, date))?.items ?? [];
    } else if (block === "visitor") {
      snap.visitors = (await getVisitorsForClass(tx, classId, date)).map((v) => ({
        visitorName: v.visitorName,
        affiliation: v.affiliation,
        scheduledTime: v.scheduledTime,
        purpose: v.purpose,
        host: v.host,
        note: v.note,
        isHighlight: v.isHighlight === true,
      }));
    } else if (block === "callout") {
      snap.callouts = (await getCalloutsForClass(tx, classId, date)).map((c) => ({
        studentName: c.studentName,
        location: c.location,
        reason: c.reason,
        scheduledTime: c.scheduledTime,
        isHighlight: c.isHighlight === true,
      }));
    }
  }
  return snap;
}

/**
 * `fromDate` の実セクション（`blocks`）を `toDate` へ置換複製する tx 内コア（前日コピー / 前週コピーが共有）。
 * 複製元が**全ブロック空**なら複製しない（`null` を返す＝対象日を誤って空に置換しない安全弁）。空でない場合は
 * 全ブロックを置換する（複製元で空のブロックは対象日も空になる＝「その日の写し」を作る従来挙動を全ブロックへ
 * 一般化）。**上書き前に対象日の {@link DaySnapshot} を控えて返す**（undo 用）。クラス可視性は呼び出し側が
 * 確認済みの前提。
 */
async function copyOneDay(
  tx: TenantTx,
  actor: ScopedEditorActor,
  target: Extract<EditorTarget, { scope: "class" }>,
  blocks: readonly SignageBlockKind[],
  labelOf: (block: SignageBlockKind) => string,
  fromDate: string,
  toDate: string,
): Promise<{ sections: CopiedSection[]; before: DaySnapshot } | null> {
  // 1) 複製元を全ブロック読み取り（同一 tx・RLS 自校限定・件数表示と共有の単一ソース）。
  const { daily, visitors, callouts, total } = await readCopySource(
    tx,
    target.classId,
    blocks,
    fromDate,
  );
  if (total === 0) {
    return null;
  }
  // 1.5) 上書き前に対象日の内容を控える（undo「元に戻す」用・RAW）。読み取りは書込と同一 tx スナップショット。
  const before = await readTargetRawSnapshot(tx, target.classId, blocks, toDate);
  // 2) 対象日へ置換保存（全ブロック同一 tx＝部分適用なし。複製元で空のブロックも空へ置換＝「その日の写し」）。
  const copied: CopiedSection[] = [];
  for (const block of blocks) {
    let count = 0;
    if (block === "schedule" || block === "notice" || block === "assignment") {
      const items = daily.get(block) ?? [];
      const field =
        block === "schedule" ? "schedules" : block === "notice" ? "notices" : "assignments";
      await upsertDailySectionForTarget(tx, actor, target, toDate, field, items);
      count = items.length;
    } else if (block === "visitor") {
      const replaced = await replaceClassVisitors(tx, {
        schoolId: actor.schoolId,
        classId: target.classId,
        date: toDate,
        items: visitors.map((v) => ({
          visitorName: v.visitorName,
          affiliation: v.affiliation,
          scheduledTime: v.scheduledTime,
          purpose: v.purpose,
          host: v.host,
          note: v.note,
          isHighlight: v.isHighlight === true,
        })),
        actorUserId: actor.actorUserId,
      });
      if (replaced === null) {
        // クラス不可視（tx 冒頭の可視確認後に消えた等の希少ケース）。他ブロックと同じ not_found 経路へ。
        throw new EditorTargetNotFoundError();
      }
      await auditRowCopy(
        tx,
        actor,
        "class_visitors",
        target.classId,
        toDate,
        fromDate,
        visitors.length,
      );
      count = visitors.length;
    } else if (block === "callout") {
      const replaced = await replaceStudentCallouts(tx, {
        schoolId: actor.schoolId,
        classId: target.classId,
        date: toDate,
        items: callouts.map((c) => ({
          studentName: c.studentName,
          location: c.location,
          reason: c.reason,
          scheduledTime: c.scheduledTime,
          isHighlight: c.isHighlight === true,
        })),
        actorUserId: actor.actorUserId,
      });
      if (replaced === null) {
        throw new EditorTargetNotFoundError();
      }
      await auditRowCopy(
        tx,
        actor,
        "student_callouts",
        target.classId,
        toDate,
        fromDate,
        callouts.length,
      );
      count = callouts.length;
    } else {
      continue;
    }
    copied.push({ block, label: labelOf(block), count });
  }
  return { sections: copied, before };
}

/**
 * 任意日コピー（統合ツール「ほかの日からコピー」の day 経路・{@link CopyFromMenu}）。指定クラスの
 * **`fromDate`**（前営業日 / 先週の同じ曜日 / 教員が選んだ任意日＝呼び出し側が算出）の実セクション
 * （実効パターンの `editableBlocksForPattern`）を、対象日 `toDate` へ**置換保存で複製**する。前営業日/週演算は
 * クライアントと同じ純関数（`previousBusinessDay` / `week-math`）で呼び出し側が確定させ、本 action は
 * 具体日付だけを受ける（コピー元がボタン上で見えている値と、実際に複製される値を一致させる）。
 *
 * - 認可（`requireRole`）→ 自校 RLS tx（`tenantScoped`）内でパターン解決 → `fromDate` を読み → `toDate` を置換。
 * - **`fromDate` に全ブロック空**なら複製しない（対象日を誤って空に置換しない安全弁＝invalid で戻す。文言は
 *   パターン別ラベルで合成）。同日（`fromDate === toDate`）は no-op の誤操作なので弾く。
 * - 対象日に既存入力がある場合の**上書き確認はクライアント側**（`CopyFromMenu` の `ConfirmDialog`）。本 action
 *   は常に置換する（呼ぶ側が確認済みの前提）。
 *
 * 全ブロックを 1 tx でまとめて書くので部分適用が起きない（全て成功 or 例外で全ロールバック）。
 *
 * 注: `toScopedEditorActor(user)` を targetSchoolId 無しで呼ぶため **system_admin は常に forbidden**（fail-closed・
 * 意図的）。コピーは教員の日常操作で /ops 横断経路は不要（必要になったら末尾引数で開ける）。
 */
export async function copyDayFromAction(
  classId: unknown,
  fromDate: unknown,
  toDate: unknown,
): Promise<ActionResult<{ fromDate: string; sections: CopiedSection[]; undo: DaySnapshot }>> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  if (!isValidDate(fromDate)) {
    return invalid("コピー元の日付が不正です (YYYY-MM-DD)。");
  }
  if (!isValidDate(toDate)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
  }
  if (fromDate === toDate) {
    return invalid("同じ日にはコピーできません。");
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
        // クラス可視性を確認（別テナント / 不存在は null）。pattern4 等 schedule を持たないパターンでも成立する
        // よう getClassName の明示チェックで判定する（前週コピーと同作法）。
        if ((await getClassName(tx, target.classId)) === null) {
          return { kind: "not_found" as const };
        }
        // 実効パターン → コピー対象 = そのパターンの実セクション（§6.4）。
        const pattern = await resolveClassPattern(tx, target.classId);
        const blocks = editableBlocksForPattern(pattern);
        const labelOf = (block: SignageBlockKind) => blockLabel(pattern, block);
        const copied = await copyOneDay(tx, actor, target, blocks, labelOf, fromDate, toDate);
        if (copied === null) {
          return { kind: "empty" as const, labels: blocks.map(labelOf) };
        }
        return { kind: "ok" as const, sections: copied.sections, undo: copied.before };
      },
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    if (result.kind === "not_found") {
      return invalid("クラスが見つかりません。");
    }
    if (result.kind === "empty") {
      return invalid(
        `コピー元（${fromDate}）に複製できる${result.labels.join("・")}がありません。`,
      );
    }
    revalidatePath(`/app/editor/${target.classId}`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { fromDate, sections: result.sections, undo: result.undo } };
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
 * コピー元プレビュー（統合ツールが「押す前に何が入るか」を見せるための読み取り専用 action）。`fromDate` の
 * 実セクションを件数だけ数えて返す（書込なし）。件数は複製の単一ソース {@link readCopySource} で数えるので、
 * **プレビューに出す件数と実際に複製される件数が一致する**（notice の固定行除外なども同じ）。
 * 空（total=0）でも `ok` で返す（呼び出し側が「複製できる内容がありません」を表示する）。
 */
export async function previewCopyDayAction(
  classId: unknown,
  fromDate: unknown,
): Promise<
  ActionResult<{
    fromDate: string;
    sections: { block: SignageBlockKind; label: string; count: number }[];
    total: number;
  }>
> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  if (!isValidDate(fromDate)) {
    return invalid("日付が不正です (YYYY-MM-DD)。");
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

  const result = await withSession(
    async (tx) => {
      if ((await getClassName(tx, target.classId)) === null) {
        return null;
      }
      const pattern = await resolveClassPattern(tx, target.classId);
      const blocks = editableBlocksForPattern(pattern);
      const source = await readCopySource(tx, target.classId, blocks, fromDate);
      const sections = blocks.map((block) => ({
        block,
        label: blockLabel(pattern, block),
        count: source.countOf(block),
      }));
      return { sections, total: source.total };
    },
    { tenantScoped: true, schoolId: actor.schoolId },
  );

  if (!result) {
    return invalid("クラスが見つかりません。");
  }
  return { ok: true, data: { fromDate, sections: result.sections, total: result.total } };
}

/**
 * 前週コピー（C2・§6.4 パターン動的化）。**`anchorDate` を含む週の月〜金**へ、**前週の同じ曜日**の
 * 実セクション（実効パターンの `editableBlocksForPattern`）を置換複製する（週は月曜始まり・曜日対応
 * 前週月→対象週月 …）。前週のその曜日が全ブロック空の日はスキップ（対象週の当該日を空に置換しない安全弁）。
 * 監査 created_by/updated_by は操作教員（actor）。**5 日ぶんを 1 tx でまとめて書く**ので部分適用が起きない
 * （全て成功 or 例外で全ロールバック。visitor / callout の行コピーが増えても tx 一括の方針は維持＝設計書 §11-9）。
 *
 * **対象週 = 教員がいま編集している日付（`anchorDate`）の週**にする（統合ツール {@link CopyFromMenu}）。
 * 旧実装は常に「JST 今日を含む週」固定で、来週を計画中に押しても今週へ書き込む混乱があった（実バグ・2026-07-12
 * ユーザー報告）。`anchorDate` 不正 / 無指定時のみ今日にフォールバックする（後方互換・fail-soft）。
 *
 * 対象週の既存入力を上書きするため、**確認ダイアログはクライアント側で必須**（`CopyFromMenu` の
 * `ConfirmDialog`）。本 action は常に置換する（呼ぶ側が確認済みの前提）。
 *
 * 注: `toScopedEditorActor(user)` を targetSchoolId 無しで呼ぶため **system_admin は常に forbidden**（fail-closed・
 * 意図的・任意日コピーと同判断）。前週コピーは教員の計画操作で /ops 横断経路は不要。
 */
export async function copyPreviousWeekAction(
  classId: unknown,
  anchorDate?: unknown,
): Promise<
  ActionResult<{
    fromWeekStart: string;
    toWeekStart: string;
    daysCopied: number;
    undo: DaySnapshot[];
  }>
> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  // 対象週は「編集中の日付」の週。不正 / 無指定は今日へフォールバック（後方互換）。
  const anchor = isValidDate(anchorDate) ? anchorDate : jstDateString();
  const toMonday = mondayOfWeek(anchor);
  const fromMonday = addDaysUtc(toMonday, -7);
  if (!isValidDate(toMonday) || !isValidDate(fromMonday)) {
    return invalid("週の計算に失敗しました。");
  }
  const toWeek = businessWeek(toMonday);
  const fromWeek = businessWeek(fromMonday);

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
        // クラス可視性を 1 度確認（別テナント / 不存在は null）。日別クエリは複製元が空でも null を返さないため、
        // ここで確かめないと不可視クラスが「全空」と区別できない。
        if ((await getClassName(tx, target.classId)) === null) {
          return { kind: "not_found" as const };
        }
        // 実効パターンは週で 1 回解決（5 日とも同じ端末＝同じパターン）。
        const pattern = await resolveClassPattern(tx, target.classId);
        const blocks = editableBlocksForPattern(pattern);
        const labelOf = (block: SignageBlockKind) => blockLabel(pattern, block);
        let daysCopied = 0;
        const undo: DaySnapshot[] = [];
        for (let i = 0; i < 5; i++) {
          const from = fromWeek[i];
          const to = toWeek[i];
          if (from && to) {
            const copied = await copyOneDay(tx, actor, target, blocks, labelOf, from, to);
            if (copied) {
              daysCopied++;
              // undo は「実際に上書きした日」だけ控える（空日はスキップ＝対象日を触っていない）。
              undo.push(copied.before);
            }
          }
        }
        return { kind: "ok" as const, daysCopied, undo, labels: blocks.map(labelOf) };
      },
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    if (result.kind === "not_found") {
      return invalid("クラスが見つかりません。");
    }
    if (result.daysCopied === 0) {
      return invalid(
        `前週（${fromMonday} の週）に複製できる${result.labels.join("・")}がありません。`,
      );
    }
    revalidatePath(`/app/editor/${target.classId}`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return {
      ok: true,
      data: {
        fromWeekStart: fromMonday,
        toWeekStart: toMonday,
        daysCopied: result.daysCopied,
        undo: result.undo,
      },
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
 * 前週コピーのプレビュー（統合ツールが「先週に何日分・何件あるか」を押す前に見せる読み取り専用 action）。
 * `anchorDate` を含む週の前週の月〜金を数え、複製元が空でない日数と総件数を返す（書込なし・`anchorDate`
 * 不正時は今日フォールバック）。件数は複製の単一ソース {@link readCopySource} で数える＝プレビューと実際の
 * 複製が一致する（前週コピーがスキップする「全空の日」もここでは nonEmptyDays に数えない）。
 */
export async function previewCopyWeekAction(
  classId: unknown,
  anchorDate?: unknown,
): Promise<
  ActionResult<{ fromWeekStart: string; toWeekStart: string; nonEmptyDays: number; total: number }>
> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  const anchor = isValidDate(anchorDate) ? anchorDate : jstDateString();
  const toMonday = mondayOfWeek(anchor);
  const fromMonday = addDaysUtc(toMonday, -7);
  if (!isValidDate(toMonday) || !isValidDate(fromMonday)) {
    return invalid("週の計算に失敗しました。");
  }
  const fromWeek = businessWeek(fromMonday);

  const user = await requireRole(DAILY_DATA_EDITOR_ROLES);
  const actor = toScopedEditorActor(user);
  if (!actor) {
    return forbidden(
      user.role === "system_admin"
        ? "対象の学校が指定されていません。"
        : "学校に属さないユーザーは編集できません。",
    );
  }

  const result = await withSession(
    async (tx) => {
      if ((await getClassName(tx, target.classId)) === null) {
        return null;
      }
      const pattern = await resolveClassPattern(tx, target.classId);
      const blocks = editableBlocksForPattern(pattern);
      let nonEmptyDays = 0;
      let total = 0;
      for (const from of fromWeek) {
        if (!from) {
          continue;
        }
        const source = await readCopySource(tx, target.classId, blocks, from);
        if (source.total > 0) {
          nonEmptyDays++;
          total += source.total;
        }
      }
      return { nonEmptyDays, total };
    },
    { tenantScoped: true, schoolId: actor.schoolId },
  );

  if (!result) {
    return invalid("クラスが見つかりません。");
  }
  return { ok: true, data: { fromWeekStart: fromMonday, toWeekStart: toMonday, ...result } };
}

/**
 * コピーの「元に戻す」（undo）。コピー/前週コピーが返した {@link DaySnapshot}[]（＝上書き前の対象日内容）を
 * その日付へ書き戻して、コピー直前の状態に復元する。統合ツール {@link CopyFromMenu} の「元に戻す」から呼ぶ。
 *
 * **client 由来のデータを書くため、書込前に全日・全ブロックをエディタ保存と同じバリデータ
 * （`validate*Items`）で再検証する**（`upsertDailySectionForTarget` は無検証で書くので、ここで fail-closed に
 * 弾かないと任意 JSON 注入経路になる）。1 つでも不正なら**何も書かず**全体を拒否する（検証は tx の外＝
 * 部分適用ゼロ）。書込は全日を 1 tx でまとめる（コピーと同じ atomic 方針）。認可・RLS・監査（ルール1/2）は
 * コピー系 action と同一（system_admin fail-closed・tenantScoped・visitor/callout は auditRowCopy）。
 */
export async function restoreCopySnapshotAction(
  classId: unknown,
  snapshots: unknown,
): Promise<ActionResult<{ daysRestored: number }>> {
  const target = parseEditorTarget("class", classId);
  if (!target || target.scope !== "class") {
    return invalid("クラスの指定が不正です。");
  }
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return invalid("元に戻すデータがありません。");
  }

  // 書込前に全日・全ブロックを保存と同じバリデータで再検証（fail-closed・部分適用ゼロ）。
  type RestoreDay = {
    date: string;
    schedules?: unknown;
    notices?: unknown;
    assignments?: unknown;
    visitors?: ClassVisitorInput[];
    callouts?: StudentCalloutInput[];
  };
  const parsed: RestoreDay[] = [];
  for (const raw of snapshots) {
    if (typeof raw !== "object" || raw === null) {
      return invalid("元に戻すデータの形式が不正です。");
    }
    const day = raw as Record<string, unknown>;
    if (!isValidDate(day.date)) {
      return invalid("元に戻すデータの日付が不正です。");
    }
    const entry: RestoreDay = { date: day.date };
    if (day.schedule !== undefined) {
      const v = validateScheduleItems(day.schedule);
      if (!v.ok) {
        return invalid(v.message);
      }
      entry.schedules = v.value;
    }
    if (day.notice !== undefined) {
      const v = validateNoticeItems(day.notice);
      if (!v.ok) {
        return invalid(v.message);
      }
      entry.notices = v.value;
    }
    if (day.assignment !== undefined) {
      const v = validateAssignmentItems(day.assignment);
      if (!v.ok) {
        return invalid(v.message);
      }
      entry.assignments = v.value;
    }
    if (day.visitors !== undefined) {
      const v = validateVisitorItems(day.visitors);
      if (!v.ok) {
        return invalid(v.message);
      }
      entry.visitors = v.value;
    }
    if (day.callouts !== undefined) {
      const v = validateCalloutItems(day.callouts);
      if (!v.ok) {
        return invalid(v.message);
      }
      entry.callouts = v.value;
    }
    parsed.push(entry);
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
        if ((await getClassName(tx, target.classId)) === null) {
          return { kind: "not_found" as const };
        }
        for (const day of parsed) {
          if (day.schedules !== undefined) {
            await upsertDailySectionForTarget(
              tx,
              actor,
              target,
              day.date,
              "schedules",
              day.schedules,
            );
          }
          if (day.notices !== undefined) {
            await upsertDailySectionForTarget(tx, actor, target, day.date, "notices", day.notices);
          }
          if (day.assignments !== undefined) {
            await upsertDailySectionForTarget(
              tx,
              actor,
              target,
              day.date,
              "assignments",
              day.assignments,
            );
          }
          if (day.visitors !== undefined) {
            const replaced = await replaceClassVisitors(tx, {
              schoolId: actor.schoolId,
              classId: target.classId,
              date: day.date,
              items: day.visitors,
              actorUserId: actor.actorUserId,
            });
            if (replaced === null) {
              throw new EditorTargetNotFoundError();
            }
            await auditRowCopy(
              tx,
              actor,
              "class_visitors",
              target.classId,
              day.date,
              day.date,
              day.visitors.length,
            );
          }
          if (day.callouts !== undefined) {
            const replaced = await replaceStudentCallouts(tx, {
              schoolId: actor.schoolId,
              classId: target.classId,
              date: day.date,
              items: day.callouts,
              actorUserId: actor.actorUserId,
            });
            if (replaced === null) {
              throw new EditorTargetNotFoundError();
            }
            await auditRowCopy(
              tx,
              actor,
              "student_callouts",
              target.classId,
              day.date,
              day.date,
              day.callouts.length,
            );
          }
        }
        return { kind: "ok" as const, daysRestored: parsed.length };
      },
      { tenantScoped: true, schoolId: actor.schoolId },
    );

    if (result.kind === "not_found") {
      return invalid("クラスが見つかりません。");
    }
    revalidatePath(`/app/editor/${target.classId}`);
    revalidatePath("/app/signage-preview/[classId]", "page");
    return { ok: true, data: { daysRestored: result.daysRestored } };
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
