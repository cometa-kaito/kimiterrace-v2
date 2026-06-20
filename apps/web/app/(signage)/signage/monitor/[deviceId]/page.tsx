import { parseSignageDate } from "@/lib/signage/rotation";
import { getSignageDisplayDataForMonitor } from "@/lib/signage/signage-display";
import { SignageClient } from "../../[classToken]/_components/SignageClient";
import { SignageInvalid } from "../../[classToken]/_components/SignageInvalid";

/**
 * モニタ起点の公開サイネージ表示ページ `/signage/monitor/{deviceId}`（Phase5 v2-PR4）。
 *
 * `/signage/{classToken}` の姉妹。端末の `signage_url` が classToken でなく **device_id** を持つ経路
 * （廊下等クラス無し端末／自端末への直指定広告を上乗せ表示する端末）で使う。`getSignageDisplayDataForMonitor`
 * が device_id を cross-tenant に解決し（resolveTvDeviceByDeviceId・system_admin 文脈）、得た schoolId だけで
 * 自校テナント文脈を開いて payload を組む（system_admin 文脈は表示読取に持ち越さない＝ルール2）。表示・ポーリング・
 * イベントは classToken 経路と同一の `SignageClient`（`basePath` でエンドポイントを切替）に委譲する。
 *
 * **認証なし・匿名公開**: テナント分離は device_id 解決 → `withTenantContext` で DB レベル強制。未登録/退役端末は
 * 静的な無効画面（classToken 経路と同方針。コンテンツを一切出さないので漏洩なし）。`device_id` は credential 扱い
 * ゆえログに出さない。middleware は `/signage/` を matcher で除外済（PR #192）なので本経路も匿名で到達できる。
 */

// device_id 解決 + RLS スコープのため静的化しない（毎リクエスト解決。退役を即時反映）。
export const dynamic = "force-dynamic";

export default async function SignageMonitorPage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<{ date?: string; design?: string }>;
}) {
  const { deviceId } = await params;
  const { date: dateParam, design } = await searchParams;

  // 既定は JST の今日。?date=YYYY-MM-DD で任意日（形式不正・無効暦日は今日へフォールバック）。
  const date = parseSignageDate(dateParam);

  // ?design=patternN は端末別デザイン（TV の signage_url が持つ）。未指定/未知は学校レベル既定→pattern1。
  const payload = await getSignageDisplayDataForMonitor(deviceId, date, design);
  if (!payload) {
    return <SignageInvalid />;
  }

  return (
    <SignageClient
      basePath={`/signage/monitor/${encodeURIComponent(deviceId)}`}
      initial={payload}
    />
  );
}
