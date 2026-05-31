import { submitFeedback } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { validateFeedbackInput } from "../../../../lib/feedback/feedback-core";

/**
 * F12 (#48-M): フィードバック投稿エンドポイント `POST /api/guide/feedback` (ADR-008 Route Handlers)。
 *
 * **非認証 (匿名)**: guide フォーム (`/guide`) から誰でも送れる (V1 feedback 受付の移植)。
 * middleware で `/api/guide/` は `__session` ゲートから除外済 (middleware.ts)。
 *
 * **RLS (ルール2)**: feedback は `system_admin_only` で守られ、匿名 INSERT は通常 INSERT では
 * 通らない。`submitFeedback` は SECURITY DEFINER 関数 `submit_feedback` 経由で 1 行だけ INSERT
 * する (migrations/0010、resolve_magic_link と同型の「RLS をくぐる唯一の扉」)。`getDb()` は
 * 非 BYPASSRLS 接続 (kimiterrace_app)。閲覧面は system_admin に限定されるため漏洩しない。
 *
 * **PII (ルール4)**: studentEpisode は PII を含みうるが保存のみ。LLM へは送らない。ログにも
 * 本文を出さない (エラー時もメッセージのみ)。
 *
 * 入力検証は `validateFeedbackInput` (純関数) が担い、範囲・必須は DB の CHECK + 関数の RAISE
 * でも二重に守る。フォーム (application/x-www-form-urlencoded) と JSON の両方を受ける。
 */

function fieldsFromForm(form: FormData) {
  return {
    schoolName: form.get("schoolName"),
    classroomLabel: form.get("classroomLabel"),
    studentReaction: form.get("studentReaction"),
    teacherUtility: form.get("teacherUtility"),
    studentEpisode: form.get("studentEpisode"),
    improvement: form.get("improvement"),
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  // フォーム送信 (guide ページ) と JSON (将来の API/テスト) の両対応。
  let raw: Parameters<typeof validateFeedbackInput>[0];
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      raw = (await request.json()) as Parameters<typeof validateFeedbackInput>[0];
    } else {
      raw = fieldsFromForm(await request.formData());
    }
  } catch {
    return NextResponse.json({ ok: false, message: "リクエスト形式が不正です。" }, { status: 400 });
  }

  const v = validateFeedbackInput(raw);
  if (!v.ok) {
    return NextResponse.json({ ok: false, message: v.message }, { status: 400 });
  }

  try {
    const id = await submitFeedback(getDb(), v.value);
    // フォーム経由は完了ページへ redirect (PRG パターン)、JSON は 201 を返す。
    if (contentType.includes("application/json")) {
      return NextResponse.json({ ok: true, id }, { status: 201 });
    }
    return NextResponse.redirect(new URL("/guide?submitted=1", request.url), 303);
  } catch {
    // 関数の RAISE (範囲外) 等。本文 (PII) はログに出さない。
    return NextResponse.json(
      { ok: false, message: "送信に失敗しました。時間をおいて再度お試しください。" },
      { status: 500 },
    );
  }
}
