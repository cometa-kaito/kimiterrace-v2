import { type EventIngestInput, recordSignageEvent } from "@/lib/signage/event-ingest";
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
 * **濫用対策**: events は実機 (50 台/校) が高頻度に発火し、校内は NAT で同一 IP に集まるため IP 単位の
 * 固定ウィンドウ制限は正規トラフィックを誤って落とす。代わりに ①有効 `classToken` 必須 (濫用は token
 * 保持者に限定、無効 token は単一 index 化された SECURITY DEFINER 解決 1 回で頭打ち)、②body サイズ上限、
 * ③payload allowlist + 厳格検証 で 1 リクエストあたりのコストを抑える。volumetric な保証は infra 層
 * WAF (Cloud Armor) が担う defense-in-depth (アプリ層での過剰な絞りは F07 のデータ欠損を招くため避ける)。
 *
 * `classToken` は credential なのでログ・レスポンスに反射しない (ルール5)。
 */

/** beacon/JSON body の最大バイト数。行動イベントは小さなオブジェクト 1 個なので十分。 */
const MAX_BODY_BYTES = 2_048;

const NO_STORE = { "cache-control": "no-store" } as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ classToken: string }> },
): Promise<NextResponse> {
  const { classToken } = await context.params;

  // body を text で受けて JSON として解釈する (beacon は text/plain でも飛ぶ)。サイズ上限超過・
  // 非 JSON・非オブジェクトは 400 に倒す (DB/解決の前に弾く)。
  let raw: EventIngestInput;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "too_large" }, { status: 413, headers: NO_STORE });
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
