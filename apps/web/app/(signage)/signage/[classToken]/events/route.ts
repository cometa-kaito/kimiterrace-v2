import { hashToken } from "@/lib/magic-link/token";
import { type EventIngestInput, recordSignageEvent } from "@/lib/signage/event-ingest";
import { SIGNAGE_EVENT_WINDOW_MS, signageEventRateLimiter } from "@/lib/signage/rate-limit";
import { NextResponse } from "next/server";

/**
 * F07 (#43): サイネージ行動イベント取り込み `POST /signage/{classToken}/events` (ADR-008 Route Handlers)。
 *
 * **匿名公開経路**: 端末は `__session` を持たない。`/signage/` は middleware の matcher で除外済なので
 * 本ハンドラに到達できる (auth レーンの middleware.ts を編集せずに済む)。可否は `classToken` 解決
 * (resolve_magic_link) が判定し、無効/失効は 410 に倒す (data ルートと同方針)。
 *
 * **送信方式**: ページ遷移時もロスしないよう `navigator.sendBeacon` での送信を主に想定する (F07
 * 受け入れ条件「beacon API でロスなく送信」)。beacon は `text/plain` の Blob でも飛ぶため、JSON /
 * text の双方を受けて JSON として解釈する。レスポンス body は不要なので成功は **204 No Content**。
 *
 * **濫用対策 — `POST /api/guide/feedback` (#234) との方針差を意図的に取る**: feedback は IP 単位の
 * 固定ウィンドウ制限を最先頭に置くが、events は実機 (50 台/校) が高頻度に発火し校内は NAT で同一 IP に
 * 集まるため、同じ IP 制限を掛けると**正規の行動ログを誤って落とし F07 のデータを欠損させる**。よって
 * events はアプリ層 IP 制限を採らず、代わりに:
 *  1. 有効 `classToken` 必須 — 濫用は token 保持者に限定。無効 token は単一 index 化された SECURITY
 *     DEFINER 解決 1 回で頭打ち (DB 書込まで到達しない)。
 *  2. **per-`classToken` の固定ウィンドウ・レート制限** (#464, #243 検証由来) を最先頭に置く。token を
 *     キーにするので NAT 共有 IP の正規端末を巻き込まず (上記 IP 制限を退けた理由を満たす)、単一 token
 *     からの flood (`view`/`tap` の無制限 INSERT による events 肥大・到達数歪曲) だけを 429 で頭打ちに
 *     する。上限は正規の単一教室トラフィックの数十倍に取り、正規ログは落とさない (`lib/signage/rate-limit.ts`)。
 *  3. **`Content-Length` を body 読込**前**に検査** + 読込後にバイト長を再検査し、上限超過は 413 で即時棄却
 *     (大 body をメモリに展開する前にコストを断つ。最終的な platform body 上限は Cloud Run が担保)。
 *  4. payload allowlist + 厳格検証で 1 リクエストあたりの処理コストを抑える。
 * volumetric な hard guarantee は依然 infra 層 WAF (Cloud Armor) が担う defense-in-depth。本 per-token
 * limiter は WAF が land するまでの安全網であって、それ単体の砦ではない。アプリ層での過剰な絞りは
 * F07 のデータ欠損を招くため避ける、という設計判断 (PR #258 Reviewer M-1 で明示化)。
 *
 * `classToken` は credential なのでログ・レスポンスに反射しない (ルール5)。
 */

/** beacon/JSON body の最大バイト数。行動イベントは小さなオブジェクト 1 個なので十分。 */
const MAX_BODY_BYTES = 2_048;

const NO_STORE = { "cache-control": "no-store" } as const;

function tooLarge(): NextResponse {
  return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ classToken: string }> },
): Promise<NextResponse> {
  const { classToken } = await context.params;

  // ① per-token レート制限 (#464): token ハッシュをキーに、単一 `classToken` からの flood を最先頭で
  // 頭打ちにする。body 読込・token 解決・DB の前に弾くので、超過時の処理コストを最小化する。平文 token は
  // credential なのでハッシュをキーにする (ルール5)。per-instance / WAF 併用前提の限界は rate-limit.ts 参照。
  if (!signageEventRateLimiter.tryAcquire(hashToken(classToken), Date.now())) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(Math.ceil(SIGNAGE_EVENT_WINDOW_MS / 1000)) },
      },
    );
  }

  // ② Content-Length が上限超過なら body を読まずに 413。正直な大 body をメモリ展開前に断つ。
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return tooLarge();
  }

  // body を text で受けて JSON として解釈する (beacon は text/plain でも飛ぶ)。③ 読込後に**バイト長**
  // (char 数でなく) を再検査 — Content-Length 不在/詐称や multibyte に備える。非 JSON・非オブジェクトは
  // 400 に倒す (DB/解決の前に弾く)。
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

  const result = await recordSignageEvent(classToken, raw);
  if (result.ok) {
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  }
  if (result.reason === "gone") {
    return NextResponse.json({ error: "gone" }, { status: 410, headers: NO_STORE });
  }
  return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
}
