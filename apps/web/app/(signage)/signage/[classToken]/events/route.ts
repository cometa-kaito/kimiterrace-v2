import { type EventIngestInput, recordSignageEvent } from "@/lib/signage/event-ingest";
import { SIGNAGE_EVENT_RETRY_AFTER_SECONDS } from "@/lib/signage/event-rate-limit";
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
 *  2. **`Content-Length` を body 読込**前**に検査** + 読込後にバイト長を再検査し、上限超過は 413 で即時棄却
 *     (大 body をメモリに展開する前にコストを断つ。最終的な platform body 上限は Cloud Run が担保)。
 *  3. payload allowlist + 厳格検証で 1 リクエストあたりの処理コストを抑える。
 *  4. **per-`classToken` 固定ウィンドウ rate limit** (M-2 #464): IP ではなく token hash をキーに、
 *     正規トラフィックを十分上回る寛容な上限を超えたら 429。NAT 共有 IP を巻き込まず、有効 token 保持者
 *     による素の view/tap flood が DB (解決 + INSERT) に到達する前に頭打ちにする (`recordSignageEvent`
 *     内で gate、限界は `lib/signage/event-rate-limit` の docstring 参照)。
 * volumetric な保証は infra 層 WAF (Cloud Armor) が担う defense-in-depth。アプリ層での過剰な絞りは
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

  // ① Content-Length が上限超過なら body を読まずに 413。正直な大 body をメモリ展開前に断つ。
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return tooLarge();
  }

  // body を text で受けて JSON として解釈する (beacon は text/plain でも飛ぶ)。② 読込後に**バイト長**
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
  if (result.reason === "rate_limited") {
    // M-2 (#464): 当該 token の固定ウィンドウ上限超過。Retry-After は窓幅 (秒) を導出して返す。
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { ...NO_STORE, "retry-after": String(SIGNAGE_EVENT_RETRY_AFTER_SECONDS) },
      },
    );
  }
  return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
}
