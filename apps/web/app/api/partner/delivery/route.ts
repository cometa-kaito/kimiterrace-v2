import {
  type DeliveryAdInput,
  type DeliveryInput,
  type DeliveryResult,
  ScopeResolutionError,
  type TenantTx,
  applyPartnerDelivery,
  withTenantContext,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { AssetPolicyError, AssetRehostError, getAssetRehost } from "@/lib/partner/asset-rehost";
import { parseDeliveryPayload } from "@/lib/partner/delivery-payload";
import {
  getConfiguredPartnerSecret,
  partnerKeyFromHeaders,
  verifyPartnerSecret,
} from "@/lib/partner/secret";
import { pgErrorCode } from "@/lib/pg-error";

/**
 * Partner API K3（`docs/api/partner-api-contract.md` §3）: **配信 push 受け口**（write・Flow B の v2 側）。
 *
 * `POST /api/partner/delivery`
 *
 * portal（商流 SoR・Vercel）が承認時に Outbox 経由で advertiser/contract/ads を v2（配信 SoR・Cloud Run）へ送り、
 * portal 由来 ID を冪等キーに upsert する。ブラウザ非経由・PII 無し・冪等（契約 §0）。K1 metrics ルートと同方針
 * （`runtime='nodejs'` / `force-dynamic` / 共有シークレット / system_admin context / BYPASSRLS 不使用）。
 *
 * ## 認証（二層 RLS の第一層 = 共有シークレット、契約 §1 / ADR-019）
 * `Authorization: Bearer <secret>`（または `x-partner-key`）を `PARTNER_API_SECRET` と SHA-256 + timingSafeEqual で
 * 定数時間比較する（`lib/partner/secret.ts`、K1 再利用）。未設定（fail-closed）/ 不一致は **401**、本体に到達させない。
 *
 * ## DB アクセス（二層 RLS の第二層 = system_admin policy、ルール2）
 * 外部呼び出しでユーザーセッションが無いため **system_admin context**（`{ userId:null, schoolId:null,
 * role:'system_admin' }`）で実行。CRM 表 + ads を全校横断に upsert する（運営入稿広告の経路）。降格しない・
 * **BYPASSRLS 不使用**・接続ロールは非 BYPASSRLS の kimiterrace_app。
 *
 * ## 【要件2】HTTP ステータス = portal の再送判断（4xx=fatal / 5xx=transient）
 * portal sender は **4xx を二度と再送しない / 5xx を再送する**。各経路を方針に沿って明示選択する:
 *   - **401**: 認証失敗（未設定 / 不一致 / 欠如）。再送で直らない。
 *   - **400**: payload 形不正・enum 外・UUID 不正・ads 0 件（バリデーション）/ asset URL ポリシー違反
 *     （非 https・内部ホスト・DNS-rebinding・リダイレクト = SSRF、`AssetPolicyError`）。再送で直らない。
 *   - **409**: 未知 v2School 等の **恒久的な整合不能**（FK 違反 23503 / check 違反 23514）。スキーマ的に
 *     受け付け不能で、同じ payload を再送しても直らない（portal 側の参照を直す必要がある）。
 *   - **5xx**: asset 取得失敗（署名 URL 期限切れ・ネットワーク, 502）/ GCS アップロード失敗（502）/ DB 一時
 *     エラー（接続断・デッドロック・直列化失敗 等, 500）。再送で回復しうる。
 * 逆にすると配信ロス（transient を 4xx）か無限再送（恒久を 5xx）になるため、恒久（4xx/409）と一時（5xx）を厳密に分ける。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 契約 §3 の 200 レスポンス形。型は DB 由来 `DeliveryResult` から派生（ルール3、as any 禁止）。 */
type DeliveryResponse = {
  applied: DeliveryResult["applied"];
  advertiserId: DeliveryResult["advertiserId"];
};

/**
 * 恒久的な整合不能と判定する Postgres エラーコード（→ 409、再送で直らない）:
 *   23503 = foreign_key_violation（未知 v2SchoolId 等、参照先が無い）
 *   23514 = check_violation（scope ↔ hierarchy id / duration > 0 等の制約違反）
 * これら以外（接続断・デッドロック 40P01・直列化 40001 等）は transient とみなし 5xx で再送させる。
 */
const PERMANENT_PG_CODES = new Set(["23503", "23514"]);

export async function POST(request: Request): Promise<NextResponse> {
  // 1. 共有シークレット検証（ルール5・fail-closed）。未設定 / 不一致 / 欠如は一律 401、本体に到達させない。
  const expected = getConfiguredPartnerSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = partnerKeyFromHeaders(request.headers);
  if (!verifyPartnerSecret(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. payload 検証（恒久・400）。JSON パース不能・形不正・enum 外・ads 0 件は再送で直らない。
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseDeliveryPayload(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: "invalid_payload", detail: parsed.error }, { status: 400 });
  }

  // 3. asset 再ホスト（transient・5xx）。短命署名 URL を取得 → 公開バケットへ再ホスト → media_url を確定。
  //    取得 / アップロード失敗は AssetRehostError（再送で回復しうる）。詳細はログにもレスポンスにも出さない
  //    （署名 URL = 短命だが秘匿、ルール5 の精神）。
  const rehost = getAssetRehost();
  const rehostedAds: DeliveryAdInput[] = [];
  for (const a of parsed.value.ads) {
    try {
      const mediaUrl = await rehost.rehost(a.assetFetchUrl, a.portalPlacementId);
      rehostedAds.push({
        portalPlacementId: a.portalPlacementId,
        v2SchoolId: a.v2SchoolId,
        scope: a.scope,
        scopeRef: a.scopeRef,
        mediaType: a.mediaType,
        durationSec: a.durationSec,
        displayOrder: a.displayOrder,
        mediaUrl,
        caption: a.caption,
        linkUrl: a.linkUrl,
      });
    } catch (err) {
      if (err instanceof AssetPolicyError) {
        // SSRF/非 https/リダイレクト等の恒久ポリシー違反。再送で直らないため 400（無限再送を防ぐ）。
        return NextResponse.json({ error: "asset_rejected" }, { status: 400 });
      }
      if (err instanceof AssetRehostError) {
        // 取得 / アップロード失敗（transient）。502 で再送を促す（4xx にすると配信ロス）。
        return NextResponse.json({ error: "asset_unavailable" }, { status: 502 });
      }
      // 想定外は 500。
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  }

  const deliveryInput: DeliveryInput = {
    advertiser: parsed.value.advertiser,
    contract: parsed.value.contract,
    ads: rehostedAds,
  };

  // 4. system_admin context（cross-tenant）の単一 tx で冪等 upsert。降格しない・BYPASSRLS 不使用。
  try {
    const result = await withTenantContext(
      getDb(),
      { userId: null, schoolId: null, role: "system_admin" },
      (tx: TenantTx) => applyPartnerDelivery(tx, deliveryInput),
    );
    const response: DeliveryResponse = {
      applied: result.applied,
      advertiserId: result.advertiserId,
    };
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // scopeRef の名前解決失敗（対象が学校内に無い/曖昧）= 恒久。再送で直らないため 409。
    if (err instanceof ScopeResolutionError) {
      return NextResponse.json({ error: "conflict" }, { status: 409 });
    }
    const code = pgErrorCode(err);
    if (code && PERMANENT_PG_CODES.has(code)) {
      // 恒久的な整合不能（未知 v2School 等）。再送で直らないため 409（portal は再送しない）。
      return NextResponse.json({ error: "conflict" }, { status: 409 });
    }
    // DB 一時エラー（接続断・デッドロック・直列化失敗 等）。詳細は返さず 500（portal は再送 = 自然回復）。
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
