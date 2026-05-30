import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { ADMIN_ROLES } from "@/lib/nav";
import { getEffectiveDailyData } from "@/lib/signage/effective-daily-data";
import { getEffectiveAdsForClass } from "@kimiterrace/db";
import { notFound } from "next/navigation";
import { SignageBoard } from "./_components/SignageBoard";

/**
 * サイネージ表示プレビュー (#48-E1)。教員・管理者が「生徒のサイネージに今どう出るか」を確認する
 * 認証付きプレビュー。`/admin` 配下なので #48-C の layout (requireRole + シェル) が掛かる。
 *
 * 公開・匿名アクセス (magic link によるクラストークン → 端末表示) と広告ローテーション等の
 * 再生制御 (Client Island) は **#48-E2** で追加する。本ページは確定状態の静的描画 + 階層マージ
 * クエリの初出。
 *
 * RLS: `withSession` で自校コンテキストを張った 1 トランザクション内で日次・広告を取得する
 * (別テナントのクラス id を渡しても RLS で不可視 → `getEffectiveDailyData` が null → 404)。
 */
const JST = "Asia/Tokyo";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function SignagePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  await requireRole(ADMIN_ROLES);
  const { classId } = await params;
  const { date: dateParam } = await searchParams;

  // 既定は JST の今日。?date=YYYY-MM-DD で任意日をプレビュー可 (形式不正は無視して今日)。
  const date =
    dateParam && DATE_RE.test(dateParam)
      ? dateParam
      : new Date().toLocaleDateString("en-CA", { timeZone: JST });

  const result = await withSession(async (tx) => {
    const daily = await getEffectiveDailyData(tx, classId, date);
    if (!daily) {
      return null;
    }
    const ads = await getEffectiveAdsForClass(tx, classId);
    return { daily, ads };
  });

  if (!result) {
    notFound();
  }

  return <SignageBoard date={date} daily={result.daily} ads={result.ads} />;
}
