import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { type EditorTarget, targetId, targetIdColumns } from "@/lib/editor/schedule-core";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  QUIET_HOURS_KIND,
  QUIET_HOURS_ROLES,
  readQuietRanges,
} from "@/lib/school-admin/quiet-hours-core";
import { findVisibleTarget, getScopeConfigValue } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { QuietHoursManager } from "../[classId]/quiet-hours/_components/QuietHoursManager";

/**
 * スコープ別 (学校全体 / 学科 / 学年) 静粛時間設定ビュー。クラス別 `/app/editor/[classId]/quiet-hours`
 * の scope 版。書込先は `school_configs` の scope=対象 + kind='quiet_hours' の 1 行 (upsert)。親階層に
 * 設定すると配下クラスのサイネージに継承表示される (effective-daily-data)。`QUIET_HOURS_ROLES`
 * (school_admin / system_admin) に限定、別テナントの対象は RLS 不可視 → 404 (findVisibleTarget)。
 */

function scopeNoun(scope: EditorTarget["scope"]): string {
  return scope === "school"
    ? "学校全体"
    : scope === "department"
      ? "学科"
      : scope === "grade"
        ? "学年"
        : "クラス";
}

function scopeEditorHref(target: EditorTarget): string {
  switch (target.scope) {
    case "school":
      return "/app/editor/scope/school";
    case "department":
      return `/app/editor/scope/department/${target.departmentId}`;
    case "grade":
      return `/app/editor/scope/grade/${target.gradeId}`;
    case "class":
      return `/app/editor/${target.classId}`;
  }
}

export async function ScopeQuietHoursView({ target }: { target: EditorTarget }) {
  await requireRole(QUIET_HOURS_ROLES);
  const cols = targetIdColumns(target);

  // tenantScoped: system_admin を school_admin に降格し system_admin_full_access policy の全校発火を止める
  // (ADR-019 §#95)。write 側 (quiet-hours-actions) と同規律で read も自校 (学科/学年) に限定する。
  const data = await withSession(
    async (tx) => {
      const visible = await findVisibleTarget(tx, cols);
      if (!visible) {
        return null;
      }
      const value = await getScopeConfigValue(tx, cols, QUIET_HOURS_KIND);
      return { name: visible.name, ranges: readQuietRanges(value) };
    },
    { tenantScoped: true },
  );

  if (!data) {
    notFound();
  }

  const noun = scopeNoun(target.scope);

  return (
    <div>
      <Breadcrumb
        items={[
          { label: "エディタ", href: "/app/editor" },
          { label: data.name, href: scopeEditorHref(target) },
          { label: "静粛時間" },
        ]}
      />
      <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>{data.name} の静粛時間</h1>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        {`サイネージを静音 / 非表示にする時間帯を設定します。ここで設定した時間帯は${noun}配下の全クラスに継承表示されます（各クラスで個別に上書きも可能）。`}
      </p>
      <QuietHoursManager
        scope={target.scope}
        targetId={targetId(target)}
        initialRanges={data.ranges}
      />
    </div>
  );
}
