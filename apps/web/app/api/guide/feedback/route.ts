import { submitFeedback } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { validateFeedbackInput } from "../../../../lib/feedback/feedback-core";
import { clientKeyFromHeaders, guideFeedbackRateLimiter } from "../../../../lib/guide/rate-limit";

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
 *
 * **濫用対策 (#234)**: 非認証公開のため IP 単位の固定ウィンドウ・レート制限を最先頭で適用し、
 * 超過は 429 + Retry-After に倒す (`lib/guide/rate-limit.ts`)。per-instance / XFF 詐称の限界が
 * あるため infra 層 WAF (Cloud Armor) と併用する前提の defense-in-depth。
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
  // 濫用対策 (#234): IP 単位の固定ウィンドウ制限。**body parse / DB の前**に弾くことで、
  // malformed flood も含めて無駄な処理ごと頭打ちにする (per-instance / XFF 詐称の限界は
  // lib/guide/rate-limit.ts 参照。ハードな保証は infra 層 WAF が担う defense-in-depth)。
  const rateKey = clientKeyFromHeaders(request.headers);
  if (!guideFeedbackRateLimiter.tryAcquire(rateKey, Date.now())) {
    return NextResponse.json(
      { ok: false, message: "送信が多すぎます。しばらくしてから再度お試しください。" },
      { status: 429, headers: { "Retry-After": "600" } },
    );
  }

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
