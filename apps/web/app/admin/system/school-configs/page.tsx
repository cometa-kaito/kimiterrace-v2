import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { formatMaskedJson } from "@/lib/system-admin/mask";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import {
  type ConfigKindValue,
  type HierarchyScopeValue,
  SCHOOL_CONFIG_SORT_KEYS,
  type SchoolConfigListEntry,
  listSchoolConfigKinds,
  listSchoolConfigPage,
} from "@/lib/system-admin/school-config-list";
import { listSchools } from "@kimiterrace/db";
import { tokens } from "@kimiterrace/ui";
import { DataListControls } from "../../_components/datalist/DataListControls";
import { DataTable } from "../../_components/datalist/DataTable";
import { PaginationNav } from "../../_components/datalist/PaginationNav";
import { type RawSearchParams, parseListParams } from "../../_components/datalist/list-params";
import { ConfigValueEditForm } from "./_components/ConfigValueEditForm";

const { color, fontSize, space } = tokens;

const BASE_PATH = "/admin/system/school-configs";

/** スコープの表示ラベル。enum 値を網羅 (型でズレ検出、ルール3)。 */
const SCOPE_LABEL: Record<HierarchyScopeValue, string> = {
  school: "学校全体",
  grade: "学年",
  class: "クラス",
  department: "学科",
};

/** 設定種別の表示ラベル。enum 値を網羅 (型でズレ検出、ルール3)。 */
const KIND_LABEL: Record<ConfigKindValue, string> = {
  display_settings: "表示設定",
  quiet_hours: "静粛時間",
  schedule_templates: "時間割テンプレート",
};

/**
 * UIUX-03: システム管理者の学校設定 (school_configs) 一覧 + 編集 (`/admin/system/school-configs`)。
 * **Server Component**。
 *
 * quiet_hours (静粛時間) / display_settings / schedule_templates を全校横断で一覧し、各行の
 * value (jsonb) をインライン編集できる。データ取得は `listSchoolConfigPage` (apps/web/lib) が
 * サーバーサイドで絞り込み、編集は `ConfigValueEditForm` (Client) → `updateSchoolConfigValueAction`
 * (Server Action) で行う。
 *
 * **スコープ: 編集 (value のみ) に限定**。新規作成・削除は提供しない —
 * `ck_school_configs_scope` (scope × grade/department/class_id の整合 CHECK) が複雑で、横断 UI から
 * 誤った組合せの行を作るリスクが高いため (school-config-actions.ts のモジュール doc 参照)。
 *
 * **認可**: `/admin` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ)。可視範囲は RLS (`system_admin_full_access`、migration 0006) に委譲し、
 * クエリ層は school_id / role の WHERE をテナント境界としては書かない (ルール2 多層防御)。
 *
 * **PII (ルール4)**: value は設定値 (時間帯・表示設定等) で生徒 PII を含まない設計だが、一覧セルは
 * 管理ビューア統一作法で `formatMaskedJson` (mask.ts) を通す。編集フォーム側は保存整合のため
 * 生 JSON を出す (ConfigValueEditForm の doc 参照)。閲覧監査は不要 (PII ビューアではない —
 * events / audit_log / ai_chat / memberships と異なり view_access 記録の対象外)。
 */
export default async function SystemSchoolConfigsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const params = parseListParams(await searchParams, {
    sortKeys: SCHOOL_CONFIG_SORT_KEYS,
    defaultSort: "updatedAt",
    defaultDir: "desc",
    filterKeys: ["school", "kind"],
  });

  const { page, kinds, schoolOptions } = await withSession(async (tx) => {
    const [page, kinds, schoolOptions] = await Promise.all([
      listSchoolConfigPage(tx, params),
      listSchoolConfigKinds(tx),
      listSchools(tx),
    ]);
    return { page, kinds, schoolOptions };
  });
  const { rows, total } = page;

  const hasCondition = params.q !== "" || Object.keys(params.filters).length > 0;

  return (
    <section>
      <header style={headerStyle}>
        <h1 style={titleStyle}>学校設定（全校）</h1>
        <span style={countStyle}>{total.toLocaleString("ja-JP")} 件</span>
      </header>
      <p style={noteStyle}>
        静粛時間・表示設定・時間割テンプレートの全校横断ビュー。各行の設定値 (JSON)
        を編集できます。新規作成・削除はスコープ整合制約が複雑なためここでは提供しません（各スコープの編集画面から作成されます）。
      </p>

      <DataListControls
        basePath={BASE_PATH}
        params={params}
        searchPlaceholder="学校名・学年/学科/クラス名・設定値"
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
            name: "kind",
            label: "種別",
            // 実在値 (selectDistinct) のみ。ラベルは enum 網羅の KIND_LABEL から引く。
            options: kinds.map((k) => ({ value: k, label: `${KIND_LABEL[k]} (${k})` })),
          },
        ]}
      />

      <DataTable
        basePath={BASE_PATH}
        params={params}
        empty={hasCondition ? "条件に合う設定がありません。" : "まだ学校設定がありません。"}
        columns={[
          { key: "schoolName", label: "学校", sortable: true },
          { key: "scope", label: "スコープ" },
          { key: "target", label: "対象" },
          { key: "kind", label: "種別", sortable: true },
          { key: "value", label: "設定値（マスク済み）" },
          { key: "updatedAt", label: "更新日時", sortable: true },
          { key: "edit", label: "編集" },
        ]}
        rows={rows.map((r) => {
          const valueText = formatMaskedJson(r.value);
          return {
            key: r.id,
            cells: [
              <strong key="school">{r.schoolName}</strong>,
              <span key="scope" style={{ whiteSpace: "nowrap" }}>
                {SCOPE_LABEL[r.scope]}
                <span style={rawStyle}> ({r.scope})</span>
              </span>,
              targetLabel(r),
              <span key="kind" style={{ whiteSpace: "nowrap" }}>
                {KIND_LABEL[r.kind]}
                <span style={rawStyle}> ({r.kind})</span>
              </span>,
              <code key="value" title={valueText} style={valueStyle}>
                {valueText}
              </code>,
              <time key="updatedAt" dateTime={r.updatedAt.toISOString()} style={dateStyle}>
                {formatJstDateTime(r.updatedAt)}
              </time>,
              <ConfigValueEditForm
                key="edit"
                configId={r.id}
                initialValueText={JSON.stringify(r.value, null, 2)}
              />,
            ],
          };
        })}
      />

      <PaginationNav basePath={BASE_PATH} params={params} total={total} />
    </section>
  );
}

/**
 * 「対象」セル: scope='school' は全体、それ以外は対象 (学年/学科/クラス) 名。
 * 参照先が消えて leftJoin が外れた場合 (通常は FK CASCADE で行ごと消えるため稀) は id 短縮で
 * 痕跡を残す (audit ページの school 列と同方針)。
 */
function targetLabel(r: SchoolConfigListEntry): React.ReactNode {
  switch (r.scope) {
    case "school":
      return <span style={{ color: color.muted }}>全体</span>;
    case "grade":
      return r.gradeName ?? shortHex(r.gradeId);
    case "department":
      return r.departmentName ?? shortHex(r.departmentId);
    case "class":
      return r.className ?? shortHex(r.classId);
  }
}

/** uuid の先頭 8 桁 (null は "—")。 */
function shortHex(value: string | null): string {
  return value ? value.slice(0, 8) : "—";
}

/** updatedAt を JST の YYYY/MM/DD HH:mm で表示する (サーバー描画、ロケール非依存)。 */
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
const rawStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const valueStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: fontSize.xs,
  color: color.muted,
  maxWidth: "20rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
