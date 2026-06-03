"use server";

import { createContent, getTeacherInput, submitTeacherInput } from "@kimiterrace/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isRoleAllowed, requireUser } from "../auth/guard";
import {
  type ExtractionSuggestions,
  isUuid,
  resolveEditorDefaults,
  toActor,
} from "../contents/publish-core";
import { withSession } from "../db";
import { type CreateDraftResult, deriveDraftTitle } from "./draft-core";
import { TEACHER_INPUT_STAFF_ROLES } from "./roles";

/**
 * F01/F02 (#509 S3b): 教員入力 (ファイル / 音声・チャット) の抽出済み transcript から
 * **下書き content を作成**し、編集→公開の既存フローへ橋渡しする Server Action (ADR-008)。
 *
 * F01 受け入れ「抽出結果を編集してから公開」/ F02 受け入れ「抽出結果は F01 と同じ編集 UI に流れる」を
 * 満たす。作成後は呼出側 (CreateDraftButton) が `/admin/contents/{contentId}` へ遷移し、既存エディタで
 * 編集 → `publishContentAction` で公開する。
 *
 * 設計: 本スライスは transcript を draft の本文に materialize する (Vertex 構造化抽出は #289 PII ゲート
 * 待ちのため非依存)。
 *
 * F01 (2026-06-03): AI 抽出が公開先 (`suggestedPublishScope`) / 掲示期間 (`suggestedPeriod`) を提案できた
 * 場合に備え、`suggestions` を任意で受け取り `resolveEditorDefaults` で **公開先の既定値** に反映する
 * (掲示期間はエディタに保存先フィールドが未実装のため pre-fill 保留)。提案が無ければ従来どおり最も狭い
 * `private` にフォールバックし、教員はエディタで常に上書きできる (F04.4 明示選択)。抽出経路 (#289/#154) が
 * `suggestions` を渡すまで挙動は不変。
 *
 * 認可 (ルール2): `requireUser` + `TEACHER_INPUT_STAFF_ROLES` で teacher/school_admin に限定
 * (生徒/保護者/system_admin は /forbidden)。content 作成は createContent の RLS WITH CHECK で
 * 自校に強制。getTeacherInput / createContent / submitTeacherInput は同一 RLS tx で実行。
 */
export async function createDraftFromInputAction(
  inputId: string,
  suggestions?: ExtractionSuggestions,
): Promise<CreateDraftResult> {
  if (!isUuid(inputId)) {
    return { ok: false, code: "invalid_input", message: "inputId が不正です。" };
  }
  const user = await requireUser();
  if (!isRoleAllowed(user.role, TEACHER_INPUT_STAFF_ROLES)) {
    redirect("/forbidden");
  }
  const actor = toActor(user);
  if (!actor) {
    return { ok: false, code: "forbidden", message: "学校に属さないユーザーは作成できません。" };
  }

  const outcome = await withSession(
    async (tx) => {
      const input = await getTeacherInput(tx, inputId);
      if (!input) {
        return { kind: "not_found" as const };
      }
      const transcript = input.transcript;
      if (!transcript || transcript.trim().length === 0) {
        return { kind: "no_transcript" as const };
      }
      // AI 提案があれば公開先の既定に反映、無ければ最も狭い「下書き（自分のみ）」(F04.4)。
      // いずれにせよ教員はエディタで明示選択・上書きできる。
      const defaults = resolveEditorDefaults(suggestions);
      const created = await createContent(tx, actor, {
        title: deriveDraftTitle(transcript),
        body: transcript,
        publishScope: defaults.publishScope,
      });
      // FR-07: この入力は content 化済み。submitted にして二重作成の起点を畳む。
      await submitTeacherInput(tx, actor.userId, inputId);
      return { kind: "ok" as const, contentId: created.id };
    },
    { allowedRoles: TEACHER_INPUT_STAFF_ROLES },
  );

  if (outcome.kind === "not_found") {
    return { ok: false, code: "not_found", message: "対象の入力が見つかりません。" };
  }
  if (outcome.kind === "no_transcript") {
    return { ok: false, code: "no_transcript", message: "本文が空のため下書きを作成できません。" };
  }
  revalidatePath("/admin/contents");
  revalidatePath("/admin/teacher-input/history");
  return { ok: true, contentId: outcome.contentId };
}
