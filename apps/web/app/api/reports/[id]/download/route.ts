import { extractClientMeta } from "@/lib/magic-link/client-meta";
import { isUuid } from "@/lib/magic-link/request";
import { writeReportDownloadAudit } from "@/lib/reports/download-audit";
import { getReportDownloadPort } from "@/lib/reports/download-port";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { ForbiddenError, UnauthenticatedError, withSession } from "@/lib/db";
import { type MonthlyReportListItem, type TenantTx, getMonthlyReport } from "@kimiterrace/db";
import { NextResponse } from "next/server";

/**
 * F09 (#45 / #430): 月次レポート PDF の **認証付き DL Route Handler** (ADR-008 Route Handlers)。
 *
 * `GET /api/reports/{id}/download` — system_admin が 1 件の月次レポート PDF を取得する。
 *
 * ## 設計判断 (proxy stream / 署名 URL を採らない・security-first)
 * GCS の公開署名 URL は **URL を知る誰でも認証なしで取得できる**共有トークンになり、生徒データを含み
 * うる校別レポートでは URL 漏洩 = 認証境界外への流出リスクになる。本ルートは署名 URL を発行せず、
 * Workload Identity (ADC) で GCS からオブジェクトを読み、**認証済みセッションのレスポンスとして
 * stream する** (token/URL を露出しない・ルール5)。`Cache-Control: no-store` で共有キャッシュにも残さない。
 *
 * ## 認可 (二層・ルール2)
 * - 第一層 (handler role gate): `withSession({ allowedRoles: SYSTEM_ADMIN_ROLES })` で teacher /
 *   school_admin / student を **403 早期 deny**。RLS は role 境界を守らないため (既知事項)、role gate を
 *   handler で必ず張る。未認証は 401。
 * - 第二層 (RLS): `getMonthlyReport` は WHERE に role/school を書かず、monthly_reports の
 *   `system_admin_full_access` policy が全校横断 SELECT を許す (system_admin は降格しない =
 *   `tenantScoped` を渡さない)。万一テナントロールが第一層を抜けても自校のみ可視 (多層防御)。
 *
 * ## 監査 (ルール1 / NFR04)
 * PDF を返す前に「誰が・どの校の・どのレポートを DL したか」を `audit_log` に追記する (PII 非格納)。
 * 監査と取得を分離し、監査が成立してから stream を返す (持ち出しの否認防止)。
 *
 * 不在 (他校 / 不存在 = RLS で不可視、または GCS にオブジェクトが無い) はすべて 404 に倒す。
 */

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse | Response> {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const meta = extractClientMeta(request.headers);

  try {
    // 認可 (system_admin only) + RLS context 内でレポート metadata を解決し、DL を監査する。
    // 同一 tx で「解決 → 監査」を完結させ、監査済みのレポートのみ後段で stream する。
    const report = await withSession(
      async (tx: TenantTx, user): Promise<MonthlyReportListItem | null> => {
        const row = await getMonthlyReport(tx, id);
        if (!row) {
          return null;
        }
        await writeReportDownloadAudit(tx, {
          actor: { uid: user.uid, role: user.role },
          reportId: row.id,
          schoolId: row.schoolId,
          targetYear: row.targetYear,
          targetMonth: row.targetMonth,
          objectPath: row.pdfStoragePath,
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return row;
      },
      { allowedRoles: SYSTEM_ADMIN_ROLES },
    );

    if (!report) {
      // 他校 / 不存在 (RLS で不可視)。情報を漏らさないよう一律 404。
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // GCS から PDF を取得し stream する (署名 URL を発行しない、ADC 経由)。
    const download = await getReportDownloadPort().fetch(report.pdfStoragePath);
    if (!download) {
      // 履歴行はあるが GCS オブジェクトが無い (生成失敗 / 退避済み等)。404 に倒す。
      return NextResponse.json({ error: "object_not_found" }, { status: 404 });
    }

    const headers = new Headers({
      "Content-Type": download.contentType,
      "Content-Disposition": `attachment; filename="${reportPdfFilename(report)}"`,
      // 認証スコープ付きの PDF を共有キャッシュへ残さない (ルール5)。
      "Cache-Control": "no-store",
    });
    if (download.contentLength !== undefined) {
      headers.set("Content-Length", String(download.contentLength));
    }
    return new Response(download.body, { status: 200, headers });
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

/**
 * DL ファイル名 `monthly-report-{YYYY}-{MM}.pdf` (月はゼロ詰め)。校名は含めない (非 ASCII の校名を
 * Content-Disposition filename に入れるとブラウザ間で文字化け/壊れるため、年月のみの安全な ASCII 名にする)。
 */
function reportPdfFilename(report: MonthlyReportListItem): string {
  const mm = String(report.targetMonth).padStart(2, "0");
  return `monthly-report-${report.targetYear}-${mm}.pdf`;
}
