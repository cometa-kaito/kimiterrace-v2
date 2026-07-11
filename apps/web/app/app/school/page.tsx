import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SCHOOL_HIERARCHY_ROLES } from "@/lib/school-admin/hub-core";
import {
  computeTodayActiveClasses,
  getSchoolHierarchy,
  getTodayDailyDataScopes,
} from "@/lib/school-admin/hub-queries";
import { parseAssignmentDeadlineFormat } from "@/lib/signage/assignment-deadline-format";
import { getSchoolDisplaySettings } from "@/lib/signage/signage-design";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { AssignmentDeadlineFormatSetting } from "./_components/AssignmentDeadlineFormatSetting";
import { HierarchyManager } from "./_components/HierarchyManager";

/**
 * 学校管理者ハブ (#48-K)。自校の学科 / 学年 / クラス階層の一覧 + 追加、およびサイネージ表示設定
 * （提出物の期日表示形式・#1258）。
 *
 * `/admin` 配下なので #48-C layout の認証ゲートが掛かるが、本ページは更にロールを
 * `SCHOOL_HIERARCHY_ROLES` (school_admin / system_admin) に絞る (teacher は 403 → /forbidden)。
 * 階層データ・表示設定は `withSession` の自校 RLS tx で取得する (ルール2)。
 */
export default async function SchoolAdminHubPage() {
  const user = await requireRole(SCHOOL_HIERARCHY_ROLES);
  const { hierarchy, statusByClass, deadlineFormat } = await withSession(async (tx) => {
    const hierarchy = await getSchoolHierarchy(tx);
    const scopes = await getTodayDailyDataScopes(tx);
    // サイネージ表示設定（学校スコープ display_settings）。行なし・不正値は既定に倒れる（fail-soft）。
    const deadlineFormat = parseAssignmentDeadlineFormat(await getSchoolDisplaySettings(tx));
    return {
      hierarchy,
      statusByClass: computeTodayActiveClasses(scopes, hierarchy.grades),
      deadlineFormat,
    };
  });
  return (
    <>
      <HierarchyManager hierarchy={hierarchy} statusByClass={statusByClass} />
      {/* サイネージ表示設定は自校運用（school_admin）専任。system_admin はテナント文脈が無く保存できないため
          出さない（保存 Action 側も forbidden で多層防御。全校横断の編集は /ops/school-configs が既存導線）。 */}
      {user.role === "school_admin" ? (
        <section aria-labelledby="signage-display-settings-heading" style={settingsSectionStyle}>
          <h2 id="signage-display-settings-heading" style={settingsHeadingStyle}>
            サイネージ表示設定
          </h2>
          <AssignmentDeadlineFormatSetting initialFormat={deadlineFormat} />
        </section>
      ) : null}
      {/* 年間行事予定表のファイル取込（ADR-049 PR-C）への導線。取込ページは school 単位・教員 +
          school_admin 認可のため、テナント文脈を持たない system_admin にはカードごと出さない
          （教員はエディタ側の導線 = PR-D から到達する）。 */}
      {user.role === "school_admin" ? (
        <section aria-labelledby="calendar-import-link-heading" style={settingsSectionStyle}>
          <h2 id="calendar-import-link-heading" style={settingsHeadingStyle}>
            年間行事予定表の取込
          </h2>
          <p style={calendarImportHintStyle}>
            Excel / CSV / PDF / 画像の年間行事予定表を AI
            で読み取り、学校の行事カレンダーとして取り込みます（保存前に内容を確認・修正できます）。
          </p>
          <Link href="/app/editor/calendar-import" style={calendarImportLinkStyle}>
            取込ページを開く →
          </Link>
        </section>
      ) : null}
    </>
  );
}

// 階層ツリーの下に罫線で区切って置く設定ゾーン（エディタの zoneSection と同じ視覚言語）。
const settingsSectionStyle: React.CSSProperties = {
  marginTop: "2rem",
  paddingTop: "1.25rem",
  borderTop: `1px solid ${tokens.color.border}`,
};
const settingsHeadingStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: 600,
  color: tokens.color.ink,
  margin: "0 0 0.6rem",
};
const calendarImportHintStyle: React.CSSProperties = {
  margin: "0 0 0.6rem",
  fontSize: tokens.fontSize.sm,
  color: tokens.color.muted,
};
// 「この学科にまとめて出す」チップ（エディタ着地）と同じ視覚言語の青チップリンク（タップ 36px）。
const calendarImportLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "36px",
  padding: "0.35rem 0.8rem",
  borderRadius: tokens.radius.md,
  background: tokens.color.infoBg,
  color: tokens.color.blueStrong,
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  textDecoration: "none",
};
