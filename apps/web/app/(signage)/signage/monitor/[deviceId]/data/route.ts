import { isMonitorAdExempt } from "@/lib/signage/monitor-ad-mode";
import { parseSignageDate } from "@/lib/signage/rotation";
import { getSignageDisplayDataForMonitor } from "@/lib/signage/signage-display";
import { NextResponse } from "next/server";

/**
 * モニタ起点サイネージの自動更新ポーリング先 `GET /signage/monitor/{deviceId}/data?date=YYYY-MM-DD`
 * （Phase5 v2-PR4・`/signage/{classToken}/data` の姉妹）。`SignageClient` が `${basePath}/data` を 5-10 秒毎に
 * 叩き、最新の payload（クラス所属端末はクラス継承∪自端末直指定、廊下端末は ads-only）を JSON で受け取る。
 *
 * - 有効 device_id: 200 + `SignagePayload`。
 * - 未登録/退役 device_id: **410 Gone**（classToken 経路と整合。クライアントは無効表示へ倒す＝即時失効反映）。
 * - キャッシュ `no-store`: 端末解決・コンテンツ鮮度・即時失効を優先し CDN/ブラウザに残さない。
 *   `device_id` は credential 扱いゆえログ・レスポンスに反射しない。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
): Promise<NextResponse> {
  const { deviceId } = await context.params;
  const search = new URL(request.url).searchParams;
  // 形式 + 実在暦日を検証し無効は今日へフォールバック（無効暦日が pg date 比較で 500 になるのを防ぐ）。
  const date = parseSignageDate(search.get("date"));
  // ?classAds=on（このモニタは授業中も広告を出す）を毎ポーリングで受け取り授業中の広告停止を免除する。
  const adExempt = isMonitorAdExempt(search.get("classAds"));
  // 端末別デザイン（SignageClient が初期 designPattern を ?design で引き継ぐ）。未指定/未知は既定へ fail-soft。
  const payload = await getSignageDisplayDataForMonitor(
    deviceId,
    date,
    search.get("design"),
    adExempt,
  );
  if (!payload) {
    return NextResponse.json(
      { error: "gone" },
      { status: 410, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
