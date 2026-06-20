import { hashToken } from "@/lib/magic-link/token";
import { type EventIngestInput, recordSignageEventForMonitor } from "@/lib/signage/event-ingest";
import { SIGNAGE_EVENT_WINDOW_MS, signageEventRateLimiter } from "@/lib/signage/rate-limit";
import { NextResponse } from "next/server";

/**
 * モニタ起点サイネージの行動イベント取り込み `POST /signage/monitor/{deviceId}/events`（Phase5 v2-PR4）。
 * `/signage/{classToken}/events` の姉妹で、テナント解決を classToken→school（resolve_magic_link）から
 * device_id→school（`recordSignageEventForMonitor` 内の `resolveTvDeviceByDeviceId`）に差し替えた版。
 *
 * **匿名公開経路**: 端末は `__session` を持たない。`/signage/` は middleware の matcher で除外済なので本ハンドラに
 * 到達できる。可否は device_id 解決（未登録/退役は 410）が判定する（data ルートと同方針）。
 *
 * **濫用対策**（classToken 版と同方針）: 校内 NAT 共有 IP の正規端末を巻き込まないため IP 制限ではなく
 * **per-device の固定ウィンドウ・レート制限**を最先頭に置く（device_id ハッシュをキーに単一端末からの flood を
 * 429 で頭打ち）。`Content-Length` を body 読込前後で検査し上限超過は 413、非 JSON/非オブジェクトは 400。
 * `device_id` は credential 扱いゆえログ・レスポンスに反射しない（ハッシュをキーにする）。
 */

/** beacon/JSON body の最大バイト数（行動イベントは小さなオブジェクト 1 個）。 */
const MAX_BODY_BYTES = 2_048;

const NO_STORE = { "cache-control": "no-store" } as const;

function tooLarge(): NextResponse {
  return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
): Promise<NextResponse> {
  const { deviceId } = await context.params;

  // ① per-device レート制限: device_id ハッシュをキーに、単一端末からの flood を最先頭で頭打ちにする。
  // body 読込・解決・DB の前に弾くので超過時の処理コストを最小化する。credential 扱いゆえハッシュをキーにする。
  if (!signageEventRateLimiter.tryAcquire(hashToken(deviceId), Date.now())) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(Math.ceil(SIGNAGE_EVENT_WINDOW_MS / 1000)) },
      },
    );
  }

  // ② Content-Length が上限超過なら body を読まずに 413。
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return tooLarge();
  }

  // body を text で受けて JSON として解釈する（beacon は text/plain でも飛ぶ）。③ 読込後にバイト長を再検査。
  let raw: EventIngestInput;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return tooLarge();
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
    }
    raw = parsed as EventIngestInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  }

  const result = await recordSignageEventForMonitor(deviceId, raw);
  if (result.ok) {
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  }
  if (result.reason === "gone") {
    return NextResponse.json({ error: "gone" }, { status: 410, headers: NO_STORE });
  }
  return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
}
