import { getDb } from "@/lib/db";
import { isUuid } from "@/lib/magic-link/request";
import {
  getConfiguredPartnerSecret,
  partnerKeyFromHeaders,
  verifyPartnerSecret,
} from "@/lib/partner/secret";
import { parseYearMonth, toYmParam } from "@/lib/reports/month";
import {
  type AdvertiserMetrics,
  type TenantTx,
  getAdvertiserMetrics,
  withTenantContext,
} from "@kimiterrace/db";
import { NextResponse } from "next/server";

/**
 * Partner API K1 (`docs/api/partner-api-contract.md` §2): **効果メトリクス pull** (read-only)。
 *
 * `GET /api/partner/advertisers/{advertiserId}/metrics?ym=YYYY-MM[&by=school]`
 *
 * portal (商流 SoR・Vercel) が server-to-server で v2 (配信 SoR・Cloud Run) から、指定広告主の指定月の
 * 効果指標 (view/tap/ask/dwell + 接触機会 presence) を取得する。これが 2 リポジトリの唯一の共有面の
 * 読み取り側 (chokepoint)。ブラウザ非経由・PII 無し・冪等 (副作用なし) (契約 §0)。
 *
 * ## 認証 (二層 RLS の第一層 = 共有シークレット、契約 §1 / ADR-019)
 * `x-partner-key: <secret>` (または `Authorization: Bearer <secret>`) を `PARTNER_API_SECRET`
 * (本番=Secret Manager / ローカル・テスト=env、ルール5) と **SHA-256 + timingSafeEqual** で定数時間比較する。
 * env 未設定 (fail-closed) / 不一致は **401**、本体処理に到達させない (`api/tv/config/route.ts` と同方式)。
 *
 * ## DB アクセス (二層 RLS の第二層 = system_admin policy、ルール2 / 契約 §0)
 * 外部 (portal) からの呼び出しでユーザーセッションが無いため、**system_admin context** で実行する
 * (`getDb()` + `withTenantContext` に `{ userId: null, schoolId: null, role: 'system_admin' }`)。CRM 表
 * (advertisers/contracts/contract_contents) は `system_admin_full_access` policy のみを持つため、この
 * context で cross-tenant に集計できる (複数校にまたがる広告主メトリクスの要件と一致)。**BYPASSRLS 不使用**・
 * 降格 (tenantScoped) はしない (全校横断が要件)。接続ロールは非 BYPASSRLS の kimiterrace_app。
 *
 * ## runtime / dynamic
 * `runtime='nodejs'`: 外部 origin からの GET を Server Action CSRF から分離し、node:crypto (定数時間比較) を
 * 使うため Edge ではなく Node に固定 (契約 §0、tv config と同方針)。`force-dynamic`: シークレット検証 +
 * cross-tenant 集計のため都度評価しキャッシュしない。
 *
 * ## エラー (契約 §2)
 * 401 (未設定/不一致) / 404 (advertiser 無) / 422 (ym 形式不正) / 400 (id 形式不正) / 500 (内部)。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 契約 §2 の 200 レスポンス形 (snake_case)。型は DB 由来 `AdvertiserMetrics` から派生する (ルール3、as any 禁止)。 */
type MetricsResponse = {
  advertiser_id: AdvertiserMetrics["advertiserId"];
  company_name: AdvertiserMetrics["companyName"];
  period: string;
  tz: "Asia/Tokyo";
  totals: {
    impressions: number;
    taps: number;
    asks: number;
    dwell_seconds: number;
    presence: number;
  };
  by_school?: Array<{
    school_id: string;
    school_name: string;
    impressions: number;
    taps: number;
    presence: number;
  }>;
  contracts: Array<{
    contract_id: string;
    status: string;
    target_school_count: number;
    monthly_fee_jpy: number;
  }>;
  generated_at: string;
  source: "live";
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // 1. 共有シークレット検証 (ルール5・fail-closed)。未設定 / 不一致 / 欠如は一律 401、本体に到達させない。
  const expected = getConfiguredPartnerSecret();
  if (expected === null) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const provided = partnerKeyFromHeaders(request.headers);
  if (!verifyPartnerSecret(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 2. パスパラメータ advertiserId は UUID 必須 (不正形式は 400、DB へ不正値を投げない)。
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_advertiser_id" }, { status: 400 });
  }

  // 3. ?ym=YYYY-MM は必須・厳格検証 (形式不正/範囲外/未指定は 422、契約 §2)。?by=school で内訳。
  const url = new URL(request.url);
  const ym = parseYearMonth(url.searchParams.get("ym"));
  if (!ym) {
    return NextResponse.json({ error: "invalid_ym" }, { status: 422 });
  }
  const bySchool = url.searchParams.get("by") === "school";

  // 4. system_admin context (cross-tenant) で単一広告主×当月を集計する。降格しない・BYPASSRLS 不使用。
  try {
    const metrics = await withTenantContext(
      getDb(),
      { userId: null, schoolId: null, role: "system_admin" },
      (tx: TenantTx) =>
        getAdvertiserMetrics(tx, {
          advertiserId: id,
          year: ym.year,
          month: ym.month,
          bySchool,
        }),
    );
    if (!metrics) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(toResponse(metrics, toYmParam(ym)), {
      status: 200,
      // 認可スコープ付きの集計を共有キャッシュへ残さない。
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // 一時的 DB エラー等。詳細は返さず 500 (portal は再送する)。RangeError は ym を 422 で先に弾くため到達しない。
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** DB 由来の集計 (`AdvertiserMetrics`) を契約 §2 の snake_case JSON 形へ写す (PII 無し・集計値のみ)。 */
function toResponse(m: AdvertiserMetrics, period: string): MetricsResponse {
  return {
    advertiser_id: m.advertiserId,
    company_name: m.companyName,
    period,
    tz: "Asia/Tokyo",
    totals: {
      impressions: m.totals.impressions,
      taps: m.totals.taps,
      asks: m.totals.asks,
      dwell_seconds: m.totals.dwellSeconds,
      presence: m.totals.presence,
    },
    ...(m.bySchool
      ? {
          by_school: m.bySchool.map((s) => ({
            school_id: s.schoolId,
            school_name: s.schoolName,
            impressions: s.impressions,
            taps: s.taps,
            presence: s.presence,
          })),
        }
      : {}),
    contracts: m.contracts.map((c) => ({
      contract_id: c.contractId,
      status: c.status,
      target_school_count: c.targetSchoolCount,
      monthly_fee_jpy: c.monthlyFeeJpy,
    })),
    generated_at: new Date().toISOString(),
    source: "live",
  };
}
