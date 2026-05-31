import { validateSignageEventBatch } from "@/lib/events/event-core";
import { signageEventsRateLimiter } from "@/lib/events/rate-limit";
import { ingestSignageEvents } from "@/lib/events/signage-events";
import { hashToken } from "@/lib/magic-link/token";
import { NextResponse } from "next/server";

/**
 * F07 行動ログ取込 `POST /signage/{classToken}/events` (#43、ADR-008 Route Handlers)。
 *
 * 公開サイネージ表示 (`/signage/{classToken}`、匿名) がクライアントで貯めた view/tap/dwell を
 * バッチ送信する先。`SignageClient` のポーリング (data route) と対になる「書き」側。
 * middleware は `/signage/` を `__session` ゲートから除外済 (匿名で到達可能、middleware.ts)。
 *
 * フロー: レート制限 (classToken ハッシュ単位) → JSON パース → バリデーション (event-core) →
 * トークン解決 + RLS 文脈で INSERT (signage-events)。
 *
 * ステータス:
 * - **202 Accepted**: 取込成功 (`{ ok, inserted }`)。fire-and-forget 解析なので 2xx で軽く返す。
 * - **400**: body 不正 / バリデーション失敗。
 * - **410 Gone**: トークン失効/期限切れ/不明 (data route と同じ「無効は 410」)。
 * - **429**: レート超過 (Retry-After)。
 * - **500**: 取込中の予期せぬ失敗 (詳細はログ・本文に出さない、ルール5)。
 *
 * `classToken` は credential なのでレスポンス・ログに反射しない。全レスポンス `no-store`。
 */

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ classToken: string }> },
): Promise<NextResponse> {
  const { classToken } = await context.params;

  // 濫用対策 (#43): classToken ハッシュ単位の固定ウィンドウ制限。**body parse / DB の前**に弾く。
  if (!signageEventsRateLimiter.tryAcquire(hashToken(classToken), Date.now())) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400, headers: NO_STORE },
    );
  }

  const v = validateSignageEventBatch(body, Date.now());
  if (!v.ok) {
    return NextResponse.json(
      { ok: false, error: "invalid", message: v.message },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await ingestSignageEvents(classToken, v.value);
    if (!result) {
      // 無効トークン (失効/期限切れ/不明)。data route と同じく 410 に倒す。
      return NextResponse.json({ ok: false, error: "gone" }, { status: 410, headers: NO_STORE });
    }
    return NextResponse.json(
      { ok: true, inserted: result.inserted },
      { status: 202, headers: NO_STORE },
    );
  } catch {
    // INSERT 失敗等。詳細 (token/PII) はログ・本文に出さない。
    return NextResponse.json(
      { ok: false, error: "ingest_failed" },
      { status: 500, headers: NO_STORE },
    );
  }
}
