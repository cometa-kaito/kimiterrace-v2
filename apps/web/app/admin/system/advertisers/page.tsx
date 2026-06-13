import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ADVERTISER_SORT_KEYS, listAdvertisersPage } from "@/lib/system-admin/advertiser-list";
import {
  ADVERTISER_STATUS_LABEL,
  ADVERTISER_STATUS_ORDER,
  type AdvertiserStatus,
} from "@/lib/system-admin/advertisers-core";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";
import { AdvertiserActiveToggle } from "./_components/AdvertiserActiveToggle";

const { color, fontSize, radius, space } = tokens;

const BASE_PATH = "/admin/system/advertisers";

/** portal (社内 ops) の admin URL (AppShell と同規約・env 上書き可・公開 URL のため env 直読み可)。 */
function portalAdminUrl(): string {
  return process.env.PORTAL_ADMIN_URL ?? "https://kimiteras.rebounder.jp/admin";
}

const retirementNoteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.infoFg,
  background: color.infoBg,
  border: `1px solid ${color.infoBorder}`,
  borderRadius: radius.sm,
  padding: `${space.sm} ${space.md}`,
  marginBottom: space.md,
};

const retirementLinkStyle: React.CSSProperties = { color: color.infoFg, fontWeight: 600 };

/**
 * F10 (#46) / UIUX-03: システム管理者の広告主一覧 (`/admin/system/advertisers`)。**Server Component**。
 *
 * UIUX-03 で共通 DataList 基盤 (検索 / 列ソート / ステータスフィルタ / 登録日範囲 / ページング) を
 * 適用し、データ取得は `listAdvertisersPage` (apps/web/lib) がサーバーサイドで絞り込む (全件スキャン
 * 廃止)。各行の操作 (稼働トグル / 広告 / 編集) と新規登録導線は従来どおり。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。広告主マスタ (CRM) は cross-tenant の横断データで system_admin 専用、
 * school_admin / teacher は 403 (`/forbidden`)。`withSession` の RLS context 下で `listAdvertisersPage`
 * を呼ぶ — 可視範囲は advertisers の RLS (`system_admin_full_access`) が決める (ルール2)。
 */
export default async function SystemAdvertisersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: ADVERTISER_SORT_KEYS,
    defaultSort: "companyName",
    defaultDir: "asc",
    filterKeys: ["status"],
  });
  const { rows, total, activeTotal } = await withSession((tx) => listAdvertisersPage(tx, params));

  return (
    <section>
      {/* UIUX-03 PR8 (商流 UI 退役・段階1): 商流の SoR は portal (実装設計書 §26/§42.2/§43)。
          本画面は「配信割当 (どの学校・クラスに何を出すか)」の管理用に残し、商流レコードの
          新規・編集は portal へ誘導する。ルートは温存 (物理削除は参照ゼロ実証後の別 PR)。 */}
      <p style={retirementNoteStyle}>
        商流（広告主マスタ・契約・コミュニケーション）の正本は{" "}
        <a href={portalAdminUrl()} style={retirementLinkStyle}>
          Rebounder 社内ポータル ↗
        </a>{" "}
        に移行しました。この画面は<strong>広告配信割当</strong>
        （各広告主の「広告」から配信先を設定）の管理用です。
      </p>
      <header style={headerStyle}>
        <h1 style={titleStyle}>広告主一覧</h1>
        <div style={headerRightStyle}>
          <span style={countStyle}>
            稼働 {activeTotal} / 全 {total} 社
          </span>
          {/* 商流SoR一元化 Phase1 (2026-06-13): 広告主の新規登録は portal (K3 自動生成) が一元管理する
              ため、v2 の手動「新規登録」導線 (/admin/system/advertisers/new) は撤去した。本画面は
              既存広告主の配信割当 (広告) と編集のみを担う。 */}
        </div>
      </header>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="会社名・業種・担当メール"
        selects={[
          {
            name: "status",
            label: "ステータス",
            // enum (advertiser_status) 全値を網羅するセレクト。並び・ラベルは core を単一ソースに使う。
            options: ADVERTISER_STATUS_ORDER.map((status) => ({
              value: status,
              label: ADVERTISER_STATUS_LABEL[status],
            })),
          },
        ]}
        dateRange
        dateRangeLabel="登録日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="条件に合う広告主がありません。"
        columns={[
          { key: "companyName", label: "会社名", sortable: true },
          { key: "industry", label: "業種", sortable: true },
          { key: "contactEmail", label: "担当連絡先" },
          { key: "status", label: "状態", sortable: true },
          { key: "createdAt", label: "登録日", sortable: true },
          { key: "actions", label: "操作" },
        ]}
        rows={rows.map((a) => ({
          key: a.id,
          cells: [
            <strong key="name">{a.companyName}</strong>,
            a.industry ?? "—",
            a.contactEmail ?? "—",
            <span key="status" style={statusCellStyle}>
              <StatusBadge status={a.status} />
              <AdvertiserActiveToggle
                advertiserId={a.id}
                isActive={a.isActive}
                companyName={a.companyName}
              />
            </span>,
            formatJstDate(a.createdAt),
            <span key="actions" style={actionsLinksStyle}>
              {/* #46 運営側広告 CRM: この広告主の広告を入稿・管理する導線。 */}
              <Link href={`/admin/system/advertisers/${a.id}/ads`} style={editLinkStyle}>
                広告
              </Link>
              <Link href={`/admin/system/advertisers/${a.id}/edit`} style={editLinkStyle}>
                編集
              </Link>
            </span>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/**
 * 営業ステータス (見込/契約中/休止) のバッジ。NFR05 (色のみに依存しない) のため、色に加えて必ず
 * 日本語ラベルを併記する。ラベルは `ADVERTISER_STATUS_LABEL` を単一ソースに使う (enum とズレない)。
 */
function StatusBadge({ status }: { status: AdvertiserStatus }) {
  return <span style={statusBadgeStyle[status]}>{ADVERTISER_STATUS_LABEL[status]}</span>;
}

/** createdAt を JST の YYYY/MM/DD で表示する (サーバー描画、ロケール非依存に固定)。 */
function formatJstDate(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: space.md,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const headerRightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space.lg,
};
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const editLinkStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.primary,
  textDecoration: "none",
};
const actionsLinksStyle: React.CSSProperties = { display: "inline-flex", gap: space.md };
const statusCellStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.6rem",
};
const badgeBaseStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  padding: `0.1rem ${space.sm}`,
  borderRadius: radius.pill,
};
/** ステータスごとのバッジ配色 (tokens のステータストーン)。色のみに依存しないよう必ずラベルと併記する (NFR05)。 */
const statusBadgeStyle: Record<AdvertiserStatus, React.CSSProperties> = {
  prospect: { ...badgeBaseStyle, background: color.warningBg, color: color.warningFg },
  active: { ...badgeBaseStyle, background: color.successBg, color: color.successFg },
  paused: { ...badgeBaseStyle, background: color.neutralBg, color: color.muted },
};
