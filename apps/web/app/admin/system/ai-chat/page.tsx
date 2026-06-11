import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  AI_CHAT_SORT_KEYS,
  listAiChatSessionsPage,
  parseRouteFilter,
  parseSchoolFilter,
  parseStatusFilter,
} from "@/lib/system-admin/ai-chat-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { writeViewAccessAudit } from "@/lib/system-admin/view-audit";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space, radius } = tokens;

const BASE_PATH = "/admin/system/ai-chat";

/** 閲覧監査 INSERT を伴うためキャッシュ禁止（描画 = 監査 1 行）。 */
export const dynamic = "force-dynamic";

/**
 * UIUX-03 PR4: ai_chat 監査ビューア（セッション一覧）。⚠ **PII 最重要**・統制は
 * docs/compliance/admin-viewer-policy.md（DRAFT）に従う:
 * - content_text は保存時マスク済み（ルール4）。本画面は逆変換を一切しない。
 * - **閲覧操作そのものを audit_log に記録**（writeViewAccessAudit、ページ描画ごと）。
 * - エクスポートなし（raw 持ち出し不可・2026-06-11 ユーザー決定）。
 * - 認可: system_admin のみ。可視範囲は RLS（tenant_isolation / system_admin_full_access）。
 */
export default async function SystemAiChatPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: AI_CHAT_SORT_KEYS,
    defaultSort: "lastMessageAt",
    defaultDir: "desc",
    filterKeys: ["school", "route", "status"],
  });

  const { page, schoolOptions } = await withSession(async (tx, user) => {
    const [pageResult, allSchools] = await Promise.all([
      listAiChatSessionsPage(tx, params),
      listSchools(tx),
    ]);
    await writeViewAccessAudit(tx, user, {
      subject: "ai_chat_view_access",
      schoolId: parseSchoolFilter(params.filters.school),
      detail: {
        q: params.q || null,
        school: parseSchoolFilter(params.filters.school),
        route: parseRouteFilter(params.filters.route),
        status: parseStatusFilter(params.filters.status),
        from: params.from,
        to: params.to,
        page: params.page,
        total: pageResult.total,
      },
    });
    return { page: pageResult, schoolOptions: allSchools };
  });

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>AIチャット監査</h1>
        <span style={countStyle}>{page.total.toLocaleString("ja-JP")} セッション</span>
      </header>
      <p style={noteStyle}>
        生徒/教員の AI 対話の監査ビューア。本文は保存時に PII
        マスキング済み（トークン表示・逆変換不可）。本ページの閲覧は監査ログに記録されます。エクスポートは提供しません（集計のみ方針）。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="メッセージ本文（マスク済）を含むセッション"
        selects={[
          {
            name: "school",
            label: "学校",
            options: schoolOptions.map((s) => ({
              value: s.id,
              label: `${s.name}（${s.prefecture}）`,
            })),
          },
          {
            name: "route",
            label: "経路",
            options: [
              { value: "student", label: "生徒（匿名）" },
              { value: "teacher", label: "教員" },
            ],
          },
          {
            name: "status",
            label: "状態",
            options: [
              { value: "active", label: "進行中" },
              { value: "closed", label: "終了" },
            ],
          },
        ]}
        dateRange
        dateRangeLabel="開始日"
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty="条件に合うセッションがありません。"
        columns={[
          { key: "startedAt", label: "開始", sortable: true },
          { key: "lastMessageAt", label: "最終発話", sortable: true },
          { key: "schoolName", label: "学校", sortable: true },
          { key: "route", label: "経路" },
          { key: "class", label: "クラス" },
          { key: "messageCount", label: "発話数", sortable: true, align: "right" },
          { key: "status", label: "状態" },
          { key: "actions", label: "" },
        ]}
        rows={page.rows.map((s) => ({
          key: s.id,
          cells: [
            formatJstDateTime(s.startedAt),
            formatJstDateTime(s.lastMessageAt),
            s.schoolName,
            s.route === "student" ? "生徒（匿名）" : "教員",
            s.className ?? "—",
            s.messageCount,
            s.closedAt ? "終了" : "進行中",
            <Link key="detail" href={`${BASE_PATH}/${s.id}`} style={detailLinkStyle}>
              対話を見る
            </Link>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={page.total} />
    </section>
  );
}

/** JST の YYYY/MM/DD HH:mm 表示（ロケール非依存に固定）。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: space.sm,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const noteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.warningFg,
  background: color.warningBg,
  border: `1px solid ${color.warningBorder}`,
  borderRadius: radius.sm,
  padding: `${space.sm} ${space.md}`,
  marginBottom: space.lg,
};
const detailLinkStyle: React.CSSProperties = { color: color.primary, fontSize: fontSize.sm };
