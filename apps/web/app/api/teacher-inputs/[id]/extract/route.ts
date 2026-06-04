import { EXTRACTION_KINDS, type ExtractionKind } from "@kimiterrace/ai";
import { NextResponse } from "next/server";
import { isAiEnabled } from "../../../../../lib/ai/ai-enabled";
import { extractTeacherInput } from "../../../../../lib/ai/extract-teacher-input";

/**
 * F03 (#154): AI 構造化抽出トリガ `POST /api/teacher-inputs/:id/extract` (ADR-008 Route Handlers)。
 *
 * 教員が対象入力の transcript を AI 構造化 (schedule / announcement / summary / tag) にかける。
 * 認証・role ゲート (teacher / school_admin)・schoolId 強制・ai_extractions 監査は seam が担保。
 * 本 route は入力 (kind) 検証と {@link extractTeacherInput} の結果 → HTTP 写像のみ担う。
 *
 * 応答: 200 (成功/失敗いずれも監査済) / 400 (kind 不正) / 401 / 403 / 404 (transcript 無) /
 * 429 (レート上限) / 422 (PII マスク漏れで中止) / 503 (AI 無効: #289 kill-switch) / 500。
 * 本文に PII / 内部詳細は出さない。
 */

type RouteContext = { params: Promise<{ id: string }> };

function isExtractionKind(v: unknown): v is ExtractionKind {
  return typeof v === "string" && (EXTRACTION_KINDS as readonly string[]).includes(v);
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  // #289 kill-switch: AI 無効時は実 Vertex を呼ぶ前に 503 で塞ぐ (既定 OFF, ルール4 / ADR-030)。
  // gate は route 境界 (ハンドラ冒頭) に置く: model getter 側に置くと default-param 評価で try 外 throw に
  // なり 500 化 + 既存テスト破壊のため (ai-enabled.ts の docstring 参照)。
  if (!isAiEnabled()) {
    return NextResponse.json({ ok: false, error: "AI 機能は現在無効です。" }, { status: 503 });
  }

  const { id } = await context.params;

  let kind: unknown;
  try {
    const body = (await request.json()) as { kind?: unknown };
    kind = body.kind;
  } catch {
    return NextResponse.json({ ok: false, error: "リクエスト形式が不正です。" }, { status: 400 });
  }
  if (!isExtractionKind(kind)) {
    return NextResponse.json(
      { ok: false, error: "kind は schedule / announcement / summary / tag のいずれかです。" },
      { status: 400 },
    );
  }

  const result = await extractTeacherInput(id, kind);

  if (result.ok) {
    return NextResponse.json(
      { ok: true, status: result.status, confidenceScore: result.confidenceScore },
      { status: 200 },
    );
  }

  switch (result.reason) {
    case "unauthenticated":
      return NextResponse.json({ ok: false, error: "認証が必要です。" }, { status: 401 });
    case "forbidden":
      return NextResponse.json({ ok: false, error: "権限がありません。" }, { status: 403 });
    case "no_transcript":
      return NextResponse.json(
        { ok: false, error: "対象の文字起こしが見つかりません。" },
        { status: 404 },
      );
    case "rate_limited":
      return NextResponse.json(
        { ok: false, error: "リクエストが多すぎます。しばらくしてから再度お試しください。" },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    case "pii_leak":
      return NextResponse.json(
        { ok: false, error: "個人情報の可能性がある語句を検出したため送信を中止しました。" },
        { status: 422 },
      );
    default:
      return NextResponse.json(
        { ok: false, error: "AI 抽出に失敗しました。時間をおいて再度お試しください。" },
        { status: 500 },
      );
  }
}
