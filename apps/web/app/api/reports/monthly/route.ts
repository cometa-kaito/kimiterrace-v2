import { monthlyCsvFilename, monthlySummaryToCsv } from "@/lib/reports/csv";
import { currentJstYearMonth, isAfterMonth, parseYearMonth } from "@/lib/reports/month";
import { ForbiddenError, UnauthenticatedError, withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { type TenantTx, getMonthlyAdReach, getMonthlySchoolSummary } from "@kimiterrace/db";
import { NextResponse } from "next/server";

/**
 * F09 (#45) 第2スライス: 月次 **学校別サマリーの CSV ダウンロード** (ADR-008 Route Handlers)。
 *
 * - GET /api/reports/monthly?ym=YYYY-MM … 対象月の学校別サマリーを CSV (text/csv) で返す
 *
 * 画面 (`/admin/reports`) と同じ `getMonthlySchoolSummary` (学校別サマリー) + `getMonthlyAdReach`
 * (広告別 到達数 reach、minute-dedup) を使い、表計算へ取り込める形で 1 ファイルに持ち帰れるようにする。
 *
 * **認可 (校務DX原則: 監視系は運営専用、画面 `/admin/reports` と整合)**: 月次レポートは閲覧系のため
 * 学校側 (teacher / school_admin) に出さず、運営 (system_admin) 専用に締める。**認可は二層** (ルール2
 * 多層防御): `allowedRoles` (SYSTEM_ADMIN_ROLES) で非対象ロールを 403 早期 deny + DB の RLS
 * (`tenant_isolation` / `system_admin_full_access`) が越境を DB レベルで止める。未認証は 401。
 *
 * 対象月は `?ym=YYYY-MM`。画面と同じく不正・未指定・未来月は現在の JST 暦月へ丸める (データ不在の
 * 未来月を要求されても安全な既定へ倒す)。集計は件数・タイトル・稼働日数・広告 caption・到達数のみで
 * PII を含まない (ルール4)。延べ表示数 (engagement) と到達数 (reach) は別指標 (ADR-025)。
 */

export async function GET(request: Request): Promise<NextResponse> {
  // 画面と同じ月解決: 不正・未指定・未来月は現在の JST 暦月へ丸める。
  const current = currentJstYearMonth();
  const url = new URL(request.url);
  const requested = parseYearMonth(url.searchParams.get("ym"));
  const target = requested && !isAfterMonth(requested, current) ? requested : current;

  try {
    const summary = await withSession(
      (tx: TenantTx) => getMonthlySchoolSummary(tx, { year: target.year, month: target.month }),
      { allowedRoles: SYSTEM_ADMIN_ROLES },
    );
    // 広告別 到達数 (reach、minute-dedup)。延べ表示数 (engagement) とは別指標 (#322 / ADR-025)。
    const adReach = await withSession(
      (tx: TenantTx) => getMonthlyAdReach(tx, { year: target.year, month: target.month }),
      { allowedRoles: SYSTEM_ADMIN_ROLES },
    );
    const csv = monthlySummaryToCsv(summary, adReach);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${monthlyCsvFilename(target.year, target.month)}"`,
        // 認可スコープ付きの集計を共有キャッシュへ残さない。
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    throw e;
  }
}
