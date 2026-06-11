import { pollTvConfig } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { clientKeyFromHeaders } from "../../../../lib/guide/rate-limit";
import { normalizeFcmToken, toLpConfigResponse } from "../../../../lib/tv/lp-compat";
import { getConfiguredTvPollSecret, verifyTvPollKey } from "../../../../lib/tv/poll-secret";
import { tvPollRateLimiter } from "../../../../lib/tv/rate-limit";

/**
 * F15 / ADR-022: **LP 互換**の TV ポーリング設定取得エンドポイント。
 * `GET /api/tv/lp-config?device_id=<id>&key=<token>`（ADR-008 Route Handler）。
 *
 * 既存 `/api/tv/config`（v2 ネイティブ camelCase + commands 配列）と**同じ認証・レート制限・解決**だが、
 * 応答だけを **LP 互換形**（snake_case + `commands` オブジェクト + `schedule.days_mask`）に変換して返す。
 * 学校に設置済みの実機 TV アプリ（`com.kimiterrace.tvbridge`、旧 LP 向けビルド）を**アプリ改修なし**で
 * v2 に向けられるようにするための互換層（cutover を端末操作ゼロにする。ユーザー: TV の LAN に入れない）。
 *
 * cutover 経路: `school-signage.net` の `/api/tv/config` を本エンドポイントへ振り向ける（LB の URL 書換 or
 * LP を薄い proxy 化）。実機の poll 先パスが固定でも、ルーティングで本互換応答を返せば実機はそのまま動く。
 *
 * 認証・解決・心拍は `/api/tv/config` と同一実装を共有: 共有シークレット（TV_POLL_SECRET、未設定/不一致は
 * 401・fail-closed）+ device 単位レート制限 + `pollTvConfig`（system_admin cross-tenant 解決・last_seen 更新・
 * BYPASSRLS 不使用、ルール2）。runtime=nodejs（定数時間比較）/ force-dynamic（last_seen 副作用でキャッシュ不可）。
 *
 * ## FCM トークン報告（遠隔起動、F16 拡張）
 * 端末アプリ（com.kimiterrace.tvbridge）は lp-config ポーリング時に `&fcmToken=<token>` を付けて最新の
 * FCM 登録トークンを報告する。本ルートは `normalizeFcmToken` で正規化（空/未指定 → `undefined`、長すぎは
 * 切り捨てず無視）し、`pollTvConfig` に渡して該当 device の `tv_devices.fcm_token` を UPSERT する（指定時のみ。
 * `undefined` は既存値を触らない＝旧 APK は無影響）。down 検知時の遠隔起動（liveness Job）と管理画面「起こす」
 * 操作がこのトークンを宛先にする。`/api/tv/config`（v2 ネイティブ）は端末が camelCase 経路で叩く別系統ゆえ
 * 本 PR では LP 互換経路（実機が現在叩く側）にのみ配線する。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id");

  // 1. device_id 必須（レート制限 key も device_id）。
  if (!deviceId) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }

  // 2. レート制限（device 単位、学校 NAT 共有でも独立）。
  if (!tvPollRateLimiter.tryAcquire(deviceId, Date.now())) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // 3. 共有シークレット検証（ルール5・未設定は fail-closed で 401）。
  const expected = getConfiguredTvPollSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = url.searchParams.get("key") ?? request.headers.get("x-tv-key");
  if (!verifyTvPollKey(provided)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 4. 設定取得 + 心拍更新（cross-tenant 解決、scoped UPDATE）。応答は LP 互換形に変換して返す。
  //    端末が報告した `&fcmToken=` を正規化して渡し、該当 device の fcm_token を UPSERT する（遠隔起動の宛先、
  //    F16 拡張）。空/未指定/長すぎは normalizeFcmToken が undefined に倒し、pollTvConfig は既存値を触らない。
  const ipKey = clientKeyFromHeaders(request.headers);
  const fcmToken = normalizeFcmToken(url.searchParams.get("fcmToken"));
  try {
    const result = await pollTvConfig(getDb(), {
      deviceId,
      lastKnownIp: ipKey === "unknown" ? null : ipKey,
      fcmToken,
    });
    return NextResponse.json(toLpConfigResponse(result), { status: 200 });
  } catch {
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
