import { type EditorTarget, targetId, targetIdColumns } from "@/lib/editor/schedule-core";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ADS_ROLES } from "@/lib/school-admin/ads-core";
import { findVisibleTarget, listOwnAds } from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdsManager } from "../[classId]/ads/_components/AdsManager";

/**
 * スコープ別 (学校全体 / 学科 / 学年) 広告管理ビュー。クラス別 `/app/editor/[classId]/ads` の scope 版。
 * `ads.scope` は school/grade/department/class を許容し、親階層の広告は `effective_ads_per_class` VIEW で
 * 配下クラスに継承表示される。本ビューは**自スコープ広告のみ**を管理する (継承広告の一覧は per-class
 * 実効ビューが要るためクラス画面に委ねる)。`ADS_ROLES` (school_admin / system_admin) に限定、別テナントの
 * 対象は RLS 不可視 → 404 (findVisibleTarget)。
 */

/** scope の語 (見出し用)。 */
function scopeNoun(scope: EditorTarget["scope"]): string {
  return scope === "school"
    ? "学校全体"
    : scope === "department"
      ? "学科"
      : scope === "grade"
        ? "学年"
        : "クラス";
}

/** スコープ編集画面 (時間割等) へ戻る href。 */
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

export async function ScopeAdsView({ target }: { target: EditorTarget }) {
  await requireRole(ADS_ROLES);
  const cols = targetIdColumns(target);

  // tenantScoped: system_admin を school_admin に降格し system_admin_full_access policy の全校発火を止める
  // (ADR-019 §#95)。これが無いと schoolId claim を持つ system_admin の findVisibleTarget が他校の 学科/学年
  // を可視と判定しうる。write 側 (ads-actions) と同規律で read も自校に限定する。
  const data = await withSession(
    async (tx) => {
      const visible = await findVisibleTarget(tx, cols);
      if (!visible) {
        return null;
      }
      const ownAds = await listOwnAds(tx, cols);
      return { name: visible.name, ownAds };
    },
    { tenantScoped: true },
  );

  // 対象が自校で不可視 (別テナント / 存在しない) なら 404。
  if (!data) {
    notFound();
  }

  const noun = scopeNoun(target.scope);
  const ownLabel = target.scope === "school" ? "学校全体" : `この${noun}`;

  return (
    <div>
      <Link href={scopeEditorHref(target)} style={{ fontSize: "0.85rem", color: "#2563eb" }}>
        ← {data.name} の編集へ戻る
      </Link>
      <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>{data.name} の広告</h1>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        {`ここで設定した広告は、${noun}配下の全クラスのサイネージに継承表示されます（各クラスで個別の広告を足すこともできます）。`}
      </p>
      <AdsManager
        scope={target.scope}
        targetId={targetId(target)}
        ownLabel={ownLabel}
        ownAds={data.ownAds}
        inherited={[]}
        showInherited={false}
      />
    </div>
  );
}
