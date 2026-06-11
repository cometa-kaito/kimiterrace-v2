import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SCHOOL_SORT_KEYS, listSchoolsPage } from "@/lib/system-admin/school-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import type { SchoolHierarchyMode } from "@kimiterrace/db/schema";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

/** 階層モードの表示ラベル (一覧の列)。enum 値を網羅 (型でズレ検出、ルール3)。 */
const HIERARCHY_MODE_LABEL: Record<SchoolHierarchyMode, string> = {
  class: "クラス制",
  department: "学科制",
};

const BASE_PATH = "/admin/system/schools";

/**
 * #48-L (#123) / UIUX-03 PR1: システム管理者の学校一覧 (`/admin/system/schools`)。**Server Component**。
 *
 * 共通 DataList 基盤 (検索 / 列ソート / 階層モードフィルタ / 登録日範囲 / ページング) の最初の
 * 適用例。データ取得は `listSchoolsPage` (apps/web/lib) がサーバーサイドで絞り込み、全件スキャン
 * をやめる。**認可**: `requireRole(SYSTEM_ADMIN_ROLES)` (system_admin のみ)、可視範囲は RLS。
 */
export default async function SystemSchoolsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: SCHOOL_SORT_KEYS,
    defaultSort: "prefecture",
    defaultDir: "asc",
    filterKeys: ["mode"],
  });
  const { rows, total } = await withSession((tx) => listSchoolsPage(tx, params));

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>学校一覧</h1>
        <div style={headerRightStyle}>
          <span style={countStyle}>{total} 校</span>
          <Link href="/admin/system/schools/new" style={newLinkStyle}>
            ＋ 新規登録
          </Link>
        </div>
      </header>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="校名・学校コード・都道府県"
        selects={[
          {
            name: "mode",
            label: "階層モード",
            options: [
              { value: "class", label: HIERARCHY_MODE_LABEL.class },
              { value: "department", label: HIERARCHY_MODE_LABEL.department },
            ],
          },
        ]}
        dateRange
        dateRangeLabel="登録日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="条件に合う学校がありません。"
        columns={[
          { key: "prefecture", label: "都道府県", sortable: true },
          { key: "name", label: "学校名", sortable: true },
          { key: "code", label: "学校コード", sortable: true },
          { key: "hierarchyMode", label: "階層モード" },
          { key: "createdAt", label: "登録日", sortable: true },
          { key: "actions", label: "" },
        ]}
        rows={rows.map((s) => ({
          key: s.id,
          cells: [
            s.prefecture,
            <Link key="name" href={`/admin/system/schools/${s.id}`} style={nameLinkStyle}>
              <strong>{s.name}</strong>
            </Link>,
            s.code ?? "—",
            HIERARCHY_MODE_LABEL[s.hierarchyMode],
            formatJstDate(s.createdAt),
            <Link key="edit" href={`/admin/system/schools/${s.id}/edit`} style={editLinkStyle}>
              編集
            </Link>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
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
const editLinkStyle: React.CSSProperties = { color: color.primary, fontSize: fontSize.sm };
const nameLinkStyle: React.CSSProperties = { color: color.ink, textDecoration: "none" };
