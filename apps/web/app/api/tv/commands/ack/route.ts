import { ackTvCommand } from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db";
import { getConfiguredTvPollSecret, verifyTvPollKey } from "../../../../../lib/tv/poll-secret";
import { tvPollRateLimiter } from "../../../../../lib/tv/rate-limit";

/**
 * F15 (ADR-022): TV リモートコマンドの **ack（受領確認）エンドポイント**。
 * `POST /api/tv/commands/ack`（ADR-008 Route Handler）。
 *
 * TV がポーリング応答（`GET /api/tv/config` の `commands[]`）で受け取った pending コマンドを実行した後、
 * 当該コマンドを `delivered` に落とすために叩く pull 経路の片割れ。サーバ → TV は能動接続しない（ADR-022）。
 *
 * ボディ（JSON）: `{ "device_id": "<uuid>", "command_id": "<uuid>" }`。
 *
 * 流れ（`GET /api/tv/config` と同じ多層防御の順序）:
 *  1. ボディ解析 + device_id / command_id 必須チェック（無ければ 400、レート制限 key も device_id）。
 *  2. レート制限（device_id 単位、ポーリングと同じ FixedWindowRateLimiter を共用）。
 *  3. 共有シークレット検証（`?key=` / `x-tv-key`、TV_POLL_SECRET、未設定/不一致は 401）。
 *  4. `ackTvCommand`（system_admin cross-tenant 解決、`(command_id, device_id)` 一致必須、pending→delivered
 *     の冪等 1 方向遷移、BYPASSRLS 不使用、ルール2）。結果を 200 で返す:
 *       - `acked`         … 今回 delivered にした
 *       - `already_acked` … 既に delivered/expired（冪等・再送）
 *       - `not_found`     … id/device 不一致（404 ではなく 200 + status で返し TV のリトライ判断に委ねる）
 *
 * **runtime='nodejs'**（GET /api/tv/config と同方針）: 外部 origin（TV）からの POST を Server Action CSRF
 * から分離し、node:crypto（定数時間比較）を使うため Node runtime に固定。`force-dynamic` で都度評価。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // 1. ボディ解析。JSON 以外 / 壊れた body は 400。
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const rec = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const deviceId = typeof rec.device_id === "string" ? rec.device_id : null;
  const commandId = typeof rec.command_id === "string" ? rec.command_id : null;
  if (!deviceId || !commandId) {
    return NextResponse.json({ error: "device_id and command_id required" }, { status: 400 });
  }

  // 2. レート制限（device_id 単位、ポーリングと共用の per-instance 第一防壁）。超過は 429。
  if (!tvPollRateLimiter.tryAcquire(deviceId, Date.now())) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // 3. 共有シークレット検証（ルール5）。未設定（fail-closed）/ 不一致は 401。
  const expected = getConfiguredTvPollSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const provided = url.searchParams.get("key") ?? request.headers.get("x-tv-key");
  if (!verifyTvPollKey(provided)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 4. 冪等 ack（cross-tenant 解決、scoped UPDATE、BYPASSRLS 不使用）。
  try {
    const result = await ackTvCommand(getDb(), { commandId, deviceId });
    return NextResponse.json(result, { status: 200 });
  } catch {
    // 一時的 DB エラー等。詳細は返さず 500（TV は次のポーリングで再 ack）。
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
