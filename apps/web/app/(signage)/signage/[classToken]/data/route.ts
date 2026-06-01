import { parseSignageDate } from "@/lib/signage/rotation";
import { getSignageDisplayData } from "@/lib/signage/signage-display";
import { NextResponse } from "next/server";

/**
 * サイネージ自動更新のポーリング先 `GET /signage/{classToken}/data?date=YYYY-MM-DD` (#48-E2 / F12)。
 * `SignageClient` が 5-10 秒ごとに叩き、最新の時間割/連絡/課題 + 実効広告を JSON で受け取る。
 * V1 Firestore `onSnapshot` の置換 (ADR-022 pull 型、ADR-008 Route Handlers)。
 *
 * - 有効トークン: 200 + `SignagePayload`。
 * - 無効/失効/期限切れトークン or 不可視クラス: **410 Gone** (F05「失効後は 410」と整合)。
 *   クライアントは 410 を「このリンクは無効」と解釈して無効表示へ倒す (= 即時失効)。
 *
 * **キャッシュ**: `no-store`。token→school 解決とコンテンツの鮮度・即時失効を優先し、CDN/ブラウザに
 * 残さない (テナント越境キャッシュの芽も摘む)。鮮度は NFR01「反映最大 60 秒」に対し余裕。
 * `classToken` は credential なのでログ・レスポンスに反射しない (ルール5)。
 */

export async function GET(
  request: Request,
  context: { params: Promise<{ classToken: string }> },
): Promise<NextResponse> {
  const { classToken } = await context.params;
  // 形式 + 実在暦日を検証し無効は今日へフォールバック (無効暦日が pg date 比較で 500 になるのを防ぐ)。
  const date = parseSignageDate(new URL(request.url).searchParams.get("date"));

  const payload = await getSignageDisplayData(classToken, date);
  if (!payload) {
    return NextResponse.json(
      { error: "gone" },
      { status: 410, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
