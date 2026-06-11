import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  MEMBERSHIP_ROLE_LABEL,
  MEMBERSHIP_SORT_KEYS,
  listMembershipPage,
  listMembershipRoles,
  parseSchoolFilter,
} from "@/lib/system-admin/membership-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { writeViewAccessAudit } from "@/lib/system-admin/view-audit";
import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/admin/system/memberships";

/**
 * 表示ごとに必ずサーバーで描画する (キャッシュ/プリレンダ禁止)。本ページは表示のたびに
 * 閲覧監査 INSERT を伴うため、キャッシュ配信 = 監査の取りこぼしになる (audit ページと同方針)。
 */
export const dynamic = "force-dynamic";

/**
 * UIUX-03: システム管理者の memberships (クラス所属) **読み取り専用**ビューア
 * (`/admin/system/memberships`)。**Server Component**。
 *
 * ## ⚠ 読み取り + マスクのみ (mutation はスコープ外)
 * **memberships 管理 (作成/付替/削除 mutation) は Opus 検証後の後続スライス。本ビューは
 * 読み取り + マスクのみ。** 「どの学校のどのクラスに、どのロールの所属が何件あるか」の
 * 運用確認 (移行検証・サポート調査) が目的で、所属の書き換え導線は提供しない。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。可視範囲は RLS (`system_admin_full_access`、migration 0002) に委譲し、
 * クエリ層は school_id / role の WHERE をテナント境界としては書かない (ルール2 多層防御)。
 *
 * **PII (ルール4)**: users (生徒含む) に join するため、表示名は `maskIdentifier` 済みの値**のみ**を
 * クエリ層 (membership-list.ts) から受け取る — 本ページは生の displayName / userId を一切持たない。
 * email 等その他の users 列は射影もしない。
 *
 * **閲覧監査 (NFR04 / ルール1)**: 本ページの表示自体を `writeViewAccessAudit`
 * (subject: "memberships_view_access") で記録する — データ取得と**同一 withSession (tx)** 内。
 * detail は絞り込み条件・page・件数のみ (閲覧された行の中身 = PII は載せない)。
 */
export default async function SystemMembershipsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: MEMBERSHIP_SORT_KEYS,
    defaultSort: "schoolName",
    defaultDir: "asc",
    filterKeys: ["school", "role"],
  });

  // データ取得と閲覧監査を同一 tx で行う — 「見たのに記録されない」を tx 境界で排除する。
  const { page, roles, schoolOptions } = await withSession(async (tx, user) => {
    const [page, roles, schoolOptions] = await Promise.all([
      listMembershipPage(tx, params),
      listMembershipRoles(tx),
      listSchools(tx),
    ]);
    await writeViewAccessAudit(tx, user, {
      subject: "memberships_view_access",
      schoolId: parseSchoolFilter(params.filters.school),
      detail: {
        q: params.q,
        school: parseSchoolFilter(params.filters.school),
        role: params.filters.role ?? null,
        page: params.page,
        total: page.total,
      },
    });
    return { page, roles, schoolOptions };
  });
  const { rows, total } = page;

  const hasCondition = params.q !== "" || Object.keys(params.filters).length > 0;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>クラス所属（全校）</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={noteStyle}>
        ユーザー × クラスの所属一覧（読み取り専用）。表示名は生徒保護のためマスク表示し、
        本ページの閲覧は監査ログに記録されます。所属の編集（mutation）は後続スライスで提供します。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="クラス名"
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
            name: "role",
            label: "ロール",
            // 実在値 (selectDistinct)。既知値は日本語ラベル併記、未知値 (varchar 柔軟運用) は生値。
            options: roles.map((r) => ({ value: r, label: roleLabel(r) })),
          },
        ]}
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={hasCondition ? "条件に合う所属がありません。" : "まだ所属データがありません。"}
        columns={[
          { key: "schoolName", label: "学校", sortable: true },
          { key: "className", label: "クラス", sortable: true },
          { key: "role", label: "ロール" },
          { key: "user", label: "ユーザー（マスク済み）" },
          { key: "createdAt", label: "作成日時" },
        ]}
        rows={rows.map((m) => ({
          key: m.id,
          cells: [
            <strong key="school">{m.schoolName}</strong>,
            <span key="class">
              {m.className}
              <span style={yearStyle}>{m.academicYear}年度</span>
            </span>,
            <span key="role" style={{ whiteSpace: "nowrap" }}>
              {roleLabel(m.membershipRole)}
            </span>,
            <span key="user">
              {m.userDisplayMasked}
              <code style={uidStyle}>{m.userIdMasked}</code>
            </span>,
            <time key="createdAt" dateTime={m.createdAt.toISOString()} style={dateStyle}>
              {formatJstDateTime(m.createdAt)}
            </time>,
          ],
        }))}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/** 既知ロールは日本語ラベル + 生値併記、未知値は生値のまま (varchar 柔軟運用)。 */
function roleLabel(role: string): string {
  const label = MEMBERSHIP_ROLE_LABEL[role];
  return label ? `${label} (${role})` : role;
}

/** createdAt を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール非依存)。 */
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
  marginBottom: space.xs,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const noteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  margin: `0 0 ${space.md}`,
};
const yearStyle: React.CSSProperties = {
  marginLeft: space.sm,
  fontSize: fontSize.xs,
  color: color.muted,
};
const uidStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: fontSize.xs,
  color: color.muted,
};
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
