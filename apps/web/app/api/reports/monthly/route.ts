import { ForbiddenError, UnauthenticatedError, withSession } from "@/lib/db";
import { PUBLISHER_ROLES } from "@/lib/contents/publish-core";
import { monthlyCsvFilename, monthlySummaryToCsv } from "@/lib/reports/csv";
import { currentJstYearMonth, isAfterMonth, parseYearMonth } from "@/lib/reports/month";
import { type TenantTx, getMonthlySchoolSummary } from "@kimiterrace/db";
import { NextResponse } from "next/server";

/**
 * F09 (#45) 第2スライス: 月次 **学校別サマリーの CSV ダウンロード** (ADR-008 Route Handlers)。
 *
 * - GET /api/reports/monthly?ym=YYYY-MM … 対象月の学校別サマリーを CSV (text/csv) で返す
 *
 * 第1スライスの画面 (`/admin/reports`) と同じ `getMonthlySchoolSummary` を使い、教員が表計算へ
 * 取り込める形で持ち帰れるようにする。**認可は二層** (ルール2 多層防御): `allowedRoles`
 * (PUBLISHER_ROLES = school_admin / teacher) で非対象ロールを 403 早期 deny + DB の
 * `tenant_isolation` が school 越境を DB レベルで止める (集計は自校スコープ)。未認証は 401。
 *
 * 対象月は `?ym=YYYY-MM`。画面と同じく不正・未指定・未来月は現在の JST 暦月へ丸める (データ不在の
 * 未来月を要求されても安全な既定へ倒す)。集計は件数・タイトル・稼働日数のみで PII を含まない (ルール4)。
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
      { allowedRoles: PUBLISHER_ROLES },
    );
    const csv = monthlySummaryToCsv(summary);
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
