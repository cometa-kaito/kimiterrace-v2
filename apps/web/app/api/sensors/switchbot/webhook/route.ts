import { recordPresenceEvent } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db";
import { clientKeyFromHeaders } from "../../../../../lib/guide/rate-limit";
import { sensorWebhookRateLimiter } from "../../../../../lib/sensors/rate-limit";
import { parsePresenceWebhook } from "../../../../../lib/sensors/switchbot";
import {
  getConfiguredWebhookSecret,
  verifyWebhookSecret,
} from "../../../../../lib/sensors/webhook-secret";

/**
 * F13 (#408, ADR-020 §2-5): SwitchBot Webhook 受信エンドポイント。
 * `POST /api/sensors/switchbot/webhook`（ADR-008 Route Handler）。
 *
 * 流れ: レート制限(IP) → 共有シークレット検証(401) → payload 検証 → device_mac→school 解決 + presence
 * イベント書込（packages/db `recordPresenceEvent`、cross-tenant 解決は system_admin policy 経由で
 * BYPASSRLS 不使用、ルール2）。認可後の非エラーは SwitchBot 再送ストームを避けるため 200 で受ける。
 */
export async function POST(request: Request): Promise<NextResponse> {
  // 1. レート制限（IP 単位）。シークレット検証より前に置き、総当たりを弱める。
  const rateKey = clientKeyFromHeaders(request.headers);
  if (!sensorWebhookRateLimiter.tryAcquire(rateKey, Date.now())) {
    return NextResponse.json(
      { status: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // 2. 共有シークレット検証（ルール5）。未設定（fail-closed）/ 不一致は 401、本体処理に到達させない。
  const expected = getConfiguredWebhookSecret();
  if (expected === null) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  const provided =
    request.headers.get("x-webhook-key") ?? new URL(request.url).searchParams.get("key");
  if (!verifyWebhookSecret(provided, expected)) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }

  // 3. ペイロード検証（認可済以降の非エラーは 200 = 再送を誘発しない）。
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "ignored", reason: "invalid_json" }, { status: 200 });
  }
  const normalized = parsePresenceWebhook(body);
  if (normalized === null) {
    return NextResponse.json({ status: "ignored", reason: "invalid_payload" }, { status: 200 });
  }

  // 4. 書込み（cross-tenant 解決 + scoped insert + 監査）。未登録/decommissioned は計上しない。
  try {
    const result = await recordPresenceEvent(getDb(), normalized);
    return NextResponse.json({ status: result.status }, { status: 200 });
  } catch {
    // 一時的 DB エラー等。詳細は返さず 500（SwitchBot は再送 = 一時障害から自然回復）。
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
