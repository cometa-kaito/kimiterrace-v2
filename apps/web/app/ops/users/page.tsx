import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { STAFF_SORT_KEYS, listStaffPage } from "@/lib/system-admin/user-list";
import type { TenantRole } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";
import { StaffActiveToggle } from "./_components/StaffActiveToggle";

const { color, fontSize, radius, space } = tokens;

const BASE_PATH = "/ops/users";

/**
 * F11 (#47 / #324) / UIUX-03: システム管理者の **全校横断 教職員一覧** (`/ops/users`)。
 * **Server Component**。
 *
 * `/app/school/members` (#318) が school_admin の **自校**ビューなのに対し、本ページは system_admin の
 * **全校横断**ビュー。ADR-026 のロール変更 / アカウント無効化 操作系 (D2 / 全校無効化 + last-admin ガード)
 * の操作 UI (各行の無効化 / 再有効化トグル) を持つ。
 *
 * UIUX-03 で共通 DataList 基盤 (検索 / 列ソート / 状態フィルタ / 登録日範囲 / ページング) を適用し、
 * データ取得は `listStaffPage` (apps/web/lib) がサーバーサイドで絞り込む (全件スキャン廃止)。
 * 教員アカウント概念の撤去 (2026-06-10): 教員は学校共通PW (ADR-032・系統A) でログインし個別アカウントを
 * 持たないため、共通教員アカウント (role=teacher の plumbing 行) は一覧に出さず school_admin のみを表示
 * する (絞り込みはクエリ層の対象絞り込みに移設。ロール列が単一値のためロールのセレクトフィルタは
 * 置かず、状態 (稼働/無効) フィルタを置く)。
 *
 * **認可**: `/admin` レイアウトの `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin / teacher は 403 `/forbidden`)。`withSession` の RLS context 下で
 * `listStaffPage` を呼ぶ — 可視範囲は `users` / `schools` の RLS (`system_admin_full_access`) が決め、
 * 手書き WHERE には依存しない (ルール2、多層防御)。
 *
 * **PII (ルール4)**: 表示名・ロール・状態・所属校・登録日のみ。email は検索条件にのみ使い表示しない
 * (query 層で射影制限)。表示名 (職員名) は system_admin がアカウント管理 (無効化 / ロール変更) で対象を
 * 識別するために必要。生徒・保護者は教職員ロールでないため一覧対象外。
 *
 * **アクセシビリティ (NFR05 / WCAG 2.2 AA)**: `<table>` + `<th scope>` (DataTable)、状態は文字ラベルで
 * 色非依存、ソート状態は記号 + `aria-sort`。
 */
export default async function SystemUsersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: STAFF_SORT_KEYS,
    defaultSort: "schoolName",
    defaultDir: "asc",
    filterKeys: ["active"],
  });
  const { rows, total, activeTotal, schoolTotal } = await withSession((tx) =>
    listStaffPage(tx, params),
  );

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>教職員管理</h1>
        <div style={headerRightStyle}>
          <span style={countStyle}>
            {schoolTotal} 校 / 稼働 {activeTotal} / 全 {total} 名
          </span>
          <Link href="/ops/users/new" style={newLinkStyle}>
            ＋ 教職員を発行
          </Link>
        </div>
      </header>
      <p style={subtitleStyle}>
        全校横断の学校管理者一覧です。各行で学校管理者アカウントの無効化 /
        再有効化を行えます。無効化は認証を即時停止し再ログインを要求します。学校で唯一の有効な学校管理者は無効化できません。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="表示名・メールアドレス・学校名"
        selects={[
          {
            name: "active",
            label: "状態",
            options: [
              { value: "true", label: "稼働中" },
              { value: "false", label: "無効" },
            ],
          },
        ]}
        dateRange
        dateRangeLabel="登録日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="条件に合う教職員がいません。"
        columns={[
          { key: "schoolName", label: "学校", sortable: true },
          { key: "displayName", label: "表示名", sortable: true },
          { key: "role", label: "ロール" },
          { key: "isActive", label: "状態", sortable: true },
          { key: "createdAt", label: "登録日", sortable: true },
          { key: "actions", label: "操作" },
        ]}
        rows={rows.map((s) => ({
          key: s.id,
          cells: [
            s.schoolName,
            <strong key="name">{s.displayName}</strong>,
            roleLabel(s.role),
            <StatusBadge key="status" isActive={s.isActive} />,
            formatJstDate(s.createdAt),
            <span key="actions" style={actionsCellStyle}>
              <StaffActiveToggle
                userId={s.id}
                isActive={s.isActive}
                displayName={s.displayName}
                schoolName={s.schoolName}
              />
            </span>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/** 稼働中 / 無効 (アカウント無効化) のステータスバッジ (色非依存で文字も出す)。 */
function StatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span style={isActive ? activeBadgeStyle : inactiveBadgeStyle}>
      {isActive ? "稼働中" : "無効"}
    </span>
  );
}

/** ロールの日本語ラベル。教職員ロールのみ一覧に出るが、網羅して将来のロール追加に備える。 */
function roleLabel(role: TenantRole): string {
  switch (role) {
    case "system_admin":
      return "システム管理者";
    case "school_admin":
      return "学校管理者";
    case "teacher":
      return "教員";
    case "student":
      return "生徒";
    case "guardian":
      return "保護者";
    default:
      return role;
  }
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

const actionsCellStyle: React.CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.3rem",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: space.sm,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700, margin: 0 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const headerRightStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space.lg,
};
const newLinkStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: "#fff",
  background: color.primary,
  padding: "0.4rem 0.9rem",
  borderRadius: "6px",
  textDecoration: "none",
};
const subtitleStyle: React.CSSProperties = { color: color.muted, margin: `0 0 ${space.lg}` };
const activeBadgeStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  padding: `0.1rem ${space.sm}`,
  borderRadius: radius.pill,
  background: color.successBg,
  color: color.successFg,
};
const inactiveBadgeStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  padding: `0.1rem ${space.sm}`,
  borderRadius: radius.pill,
  background: color.neutralBg,
  color: color.muted,
};
