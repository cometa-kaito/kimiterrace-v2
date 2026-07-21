import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { AdsManager } from "@/app/app/editor/[classId]/ads/_components/AdsManager";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { type EditorTarget, targetId, targetIdColumns } from "@/lib/editor/schedule-core";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { findVisibleTarget, listOwnAds } from "@kimiterrace/db";
import { notFound } from "next/navigation";

/**
 * **system_admin（運営）がスコープ (学校全体 / 学科 / 学年) 広告を編集する共通ビュー** (`/ops/schools/{id}/ads/scope/...`)。
 * **Server Component**。`/ops/schools/{id}/ads`（掲載先ピッカー）からの遷移先で、`ads/[classId]`（クラス別）の
 * **scope 版**。学校 / 学科 / 学年に掲載した広告は `effective_ads_per_class` VIEW で配下の全クラスに継承表示される
 * （「一括掲載」＝親スコープ 1 件で配下全クラスに出す、の実体）。
 *
 * school_admin 向けの {@link import("@/app/app/editor/scope/ScopeAdsView").ScopeAdsView} と同型だが、
 * **対象校スコープ (ADR-019 §#95 / hub #998・#999・ads/[classId] と同型)** で system_admin が他校を編集する:
 * データ取得は `withSession(..., { tenantScoped: true, schoolId })` の**対象校 RLS tx** で行い、actor を tx 内で
 * school_admin に降格して対象校以外を不可視にする。編集 UI (`AdsManager`) には `schoolId` を渡して各 Server Action を
 * 対象校に結ぶ（越境防止のゲートはサーバ側 `toAdsActor`/`withSession`）。対象 (学科/学年) が対象校で不可視 / 不存在なら 404
 * (`findVisibleTarget`)。校名・存在確認は呼び出し側（page）が全校読取の `getSchoolDetail` で済ませ、本ビューへ渡す。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`（多層防御・棚卸し耐性で
 * ページ本体でも同集合を直接ガードする方針、`/app/editor/scope` と同思想）。
 */
export async function OpsScopeAdsView({
  schoolId,
  schoolName,
  target,
}: {
  /** 対象校 ID（UUID 検証済みを渡す）。 */
  schoolId: string;
  /** 対象校名（breadcrumb / バナー用。全校読取の getSchoolDetail で取得済みを渡す）。 */
  schoolName: string;
  /** 編集対象スコープ。school / department / grade を想定（class は `ads/[classId]` が担う）。 */
  target: EditorTarget;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const cols = targetIdColumns(target);

  // 対象校に降格スコープした tx でスコープの可視性 + 自スコープ広告を読む（他校は不可視 → 404）。
  const data = await withSession(
    async (tx) => {
      const visible = await findVisibleTarget(tx, cols);
      if (!visible) {
        return null;
      }
      const ownAds = await listOwnAds(tx, cols);
      return { name: visible.name, ownAds };
    },
    { tenantScoped: true, schoolId },
  );

  // 対象が対象校で不可視（別テナント / 不存在）なら 404。
  if (!data) {
    notFound();
  }

  const noun = scopeNoun(target.scope);
  // 見出し / バナーの対象語。school は固定「学校全体」、学科/学年は対象名（findVisibleTarget の name）。
  const targetLabel = target.scope === "school" ? "学校全体" : data.name;
  const ownLabel = target.scope === "school" ? "学校全体" : `この${noun}`;
  const inheritScope = target.scope === "school" ? "この学校" : `この${noun}`;

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: schoolName, href: `/ops/schools/${schoolId}` },
          { label: "広告掲載", href: `/ops/schools/${schoolId}/ads` },
          { label: targetLabel },
        ]}
      />

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>
            システム管理者として「{schoolName}」{targetLabel} の広告を編集しています。
          </strong>
          <br />
          この学校のテナント範囲に限定され、すべての追加・変更・削除は監査ログに記録されます。
        </span>
      </div>

      <h1 style={titleStyle}>{targetLabel} の広告</h1>
      <p style={subtitleStyle}>
        ここで設定した広告は、{inheritScope}
        配下の全クラスのサイネージに継承表示されます（各クラスで個別の広告を足すこともできます）。
      </p>
      <AdsManager
        scope={target.scope}
        targetId={targetId(target)}
        schoolId={schoolId}
        ownLabel={ownLabel}
        ownAds={data.ownAds}
        inherited={[]}
        showInherited={false}
      />
    </div>
  );
}

/** scope の語（見出し用）。class は本ビューでは使わないが型網羅のため残す。 */
function scopeNoun(scope: EditorTarget["scope"]): string {
  return scope === "school"
    ? "学校全体"
    : scope === "department"
      ? "学科"
      : scope === "grade"
        ? "学年"
        : "クラス";
}

const pageStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1rem" };
const bannerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.6rem",
  background: "#fef9c3",
  border: "1px solid #fde68a",
  borderRadius: "8px",
  padding: "0.75rem 0.9rem",
  fontSize: "0.85rem",
  lineHeight: 1.6,
  color: "#854d0e",
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const subtitleStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.9rem", margin: 0 };
