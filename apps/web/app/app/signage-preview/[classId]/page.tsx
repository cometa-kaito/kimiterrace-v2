import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ADMIN_ROLES } from "@/lib/nav";
import { parseAssignmentDeadlineFormat } from "@/lib/signage/assignment-deadline-format";
import { getEffectiveDailyData } from "@/lib/signage/effective-daily-data";
import { parseSignageDate } from "@/lib/signage/rotation";
import { getSchoolDisplaySettings } from "@/lib/signage/signage-design";
import { getEffectiveAdsForClass, getVisibleClassSchoolId } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { SignageBoard } from "./_components/SignageBoard";

/**
 * サイネージ表示プレビュー (#48-E1)。教員・管理者が「生徒のサイネージに今どう出るか」を確認する
 * 認証付きプレビュー。`/app` 配下なので #48-C の layout (requireRole + シェル) が掛かる。
 *
 * 公開・匿名アクセス (magic link によるクラストークン → 端末表示) と広告ローテーション等の
 * 再生制御 (Client Island) は **#48-E2** で追加する。本ページは確定状態の静的描画 + 階層マージ
 * クエリの初出。
 *
 * RLS: `withSession` で自校コンテキストを張った 1 トランザクション内で日次・広告を取得する
 * (別テナントのクラス id を渡しても RLS で不可視 → `getEffectiveDailyData` が null → 404)。
 *
 * **system_admin の対象校スコープ (#1264 / ADR-041 P1)**: system_admin は自校を持たず
 * `system_admin_full_access` で全校可視のため、そのまま `getSchoolDisplaySettings` (school_id 条件なしの
 * LIMIT 1) を読むと**別校**の display_settings (assignmentDeadlineFormat / signageDesign) を拾いうる。
 * 対象クラスから school_id を導出し (`getVisibleClassSchoolId`)、本体 tx を
 * `withSession(..., { tenantScoped: true, schoolId })` で **対象校に降格スコープ**して読む
 * (/ops/schools/[id]/editor/[classId] と同型)。tenant ロールは schoolId override が無視され自校固定 =
 * 従来動作 (回帰なし)。
 */
export default async function SignagePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireRole(ADMIN_ROLES);
  const { classId } = await params;
  const { date: dateParam } = await searchParams;

  // 既定は JST の今日。?date=YYYY-MM-DD で任意日をプレビュー可。形式不正だけでなく無効暦日
  // (2026-13-45 等) も今日へフォールバックし、pg date 比較の 500 (CWE-20) を防ぐ (#453, #446)。
  const date = parseSignageDate(dateParam);

  // system_admin のみ: 対象クラスから school_id を導出する (full_access 読取・ADR-041 P2 と同じ
  // 「対象から学校導出」)。不存在 / 不正 id は null → 404。tenant ロールは自校固定なので導出不要
  // (round-trip を増やさない)。
  const targetSchoolId =
    user.role === "system_admin"
      ? await withSession((tx) => getVisibleClassSchoolId(tx, classId))
      : null;
  if (user.role === "system_admin" && !targetSchoolId) {
    notFound();
  }

  const result = await withSession(
    async (tx) => {
      const daily = await getEffectiveDailyData(tx, classId, date);
      if (!daily) {
        return null;
      }
      const ads = await getEffectiveAdsForClass(tx, classId);
      // 提出物の期日表示形式（#1258 学校別設定）。実機盤面（buildSignagePayloadForClass）と同じ
      // display_settings 行から defensive にパースし、プレビューを実機表記に一致させる。
      const deadlineFormat = parseAssignmentDeadlineFormat(await getSchoolDisplaySettings(tx));
      return { daily, ads, deadlineFormat };
    },
    // 対象校に降格スコープ (system_admin 越境読取の封じ込め、#1264)。tenant ロールは schoolId=null で
    // override されず自校固定・tenantScoped も no-op (tenantScopedContext は system_admin のみ降格)。
    { tenantScoped: true, schoolId: targetSchoolId },
  );

  if (!result) {
    notFound();
  }

  return (
    <SignageBoard
      date={date}
      daily={result.daily}
      ads={result.ads}
      assignmentDeadlineFormat={result.deadlineFormat}
    />
  );
}
