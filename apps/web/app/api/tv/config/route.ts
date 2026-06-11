import { type PendingTvCommand, pollPendingTvCommands, pollTvConfig } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../lib/db";
import { clientKeyFromHeaders } from "../../../../lib/guide/rate-limit";
import { getConfiguredTvPollSecret, verifyTvPollKey } from "../../../../lib/tv/poll-secret";
import { tvPollRateLimiter } from "../../../../lib/tv/rate-limit";

/**
 * F15/F16 (ADR-022 §設計詳細 / ADR-023 §土台): TV ポーリング設定取得エンドポイント。
 * `GET /api/tv/config?device_id=<uuid>&key=<token>`（ADR-008 Route Handler）。
 *
 * 学校設置の Google TV（`com.kimiterrace.tvbridge`）が **60 秒ごと**に叩く pull 経路。サーバ → TV へは
 * 一度も能動接続しない（ADR-022: 学校 Wi-Fi はアウトバウンドのみ許可が多い）。
 *
 * 流れ:
 *  1. device_id 必須チェック（無ければ 400、レート制限 key も device_id ゆえ先に取る）
 *  2. レート制限（device_id 単位、ADR-022: 1 分 5 リクエスト）
 *  3. 共有シークレット検証（`?key=` / `x-tv-key`、TV_POLL_SECRET、ADR-022。未設定/不一致は 401）
 *  4. `device_id → school_id` を cross-tenant 解決して設定を返しつつ `last_seen_at` を更新
 *     （packages/db `pollTvConfig`、system_admin policy 経由で BYPASSRLS 不使用、ルール2）。
 *     未登録 device_id は `{ unknown: true, version: 0 }`（F15 §2、UI 側で未登録ポーリング検出通知）。
 *  5. 登録済みなら自分宛の **pending リモートコマンド**を同梱（F15 §1/§4.2、ADR-022 `commands.*`）。
 *     `pollPendingTvCommands`（同じ system_admin cross-tenant 解決）で取得し、最小 payload（id +
 *     command + params、PII 非格納）を返す。TV は実行後 `POST /api/tv/commands/ack` で delivered に落とす
 *     （冪等）。コマンド取得失敗は config 配信を妨げない（commands は空配列にフォールバック）。
 *
 * **runtime='nodejs'**（F15 §5）: 外部 origin（TV）からの GET を Server Action CSRF から分離し、
 * node:crypto（定数時間比較）を使うため Edge ではなく Node runtime に固定する。`force-dynamic` で
 * 都度評価（last_seen 更新の副作用がありキャッシュ不可）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get("device_id");

  // 1. device_id 必須。無い／空はポーリングとして不正（400）。レート制限の key も device_id を使うため
  //    解決より前に弾く。
  if (!deviceId) {
    return NextResponse.json({ error: "device_id required" }, { status: 400 });
  }

  // 2. レート制限（device_id 単位）。学校 NAT 越しに複数 TV が同一 IP を共有しても device 単位で独立。
  //    超過は 429。
  if (!tvPollRateLimiter.tryAcquire(deviceId, Date.now())) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // 3. 共有シークレット検証（ルール5）。未設定（fail-closed）/ 不一致は 401、本体処理に到達させない。
  const expected = getConfiguredTvPollSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = url.searchParams.get("key") ?? request.headers.get("x-tv-key");
  if (!verifyTvPollKey(provided)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 4. 設定取得 + 心拍更新（cross-tenant 解決、scoped UPDATE、BYPASSRLS 不使用）。
  //    last_known_ip は XFF 由来（clientKeyFromHeaders と同じ左端 client IP。診断用途のため厳密性は不問）。
  const ipKey = clientKeyFromHeaders(request.headers);
  try {
    const result = await pollTvConfig(getDb(), {
      deviceId,
      lastKnownIp: ipKey === "unknown" ? null : ipKey,
    });
    // 未登録（unknown）はコマンドを引かず従来通りの形をそのまま返す（解決行が無く配信対象も無い）。
    if (result.unknown) {
      return NextResponse.json(result, { status: 200 });
    }
    // 5. 登録済み: 自分宛の pending コマンドを同梱。取得失敗は config 配信を止めない（空配列）。
    let commands: PendingTvCommand[] = [];
    try {
      commands = await pollPendingTvCommands(getDb(), deviceId);
    } catch {
      commands = [];
    }
    return NextResponse.json({ ...result, commands }, { status: 200 });
  } catch {
    // 一時的 DB エラー等。詳細は返さず 500（TV は次のポーリングで自然回復）。
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
