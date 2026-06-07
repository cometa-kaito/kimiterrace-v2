import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import {
  QUIET_HOURS_KIND,
  QUIET_HOURS_ROLES,
  readQuietRanges,
} from "@/lib/school-admin/quiet-hours-core";
import { findVisibleClass, getClassConfigValue } from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { QuietHoursManager } from "./_components/QuietHoursManager";

/**
 * クラス別 静粛時間設定 (#48-J-2)。指定クラスの **quiet_hours** (サイネージを静音 / 非表示にする
 * 時間帯) を設定する。書込先は `school_configs` の scope='class' + kind='quiet_hours' の 1 行 (upsert)。
 *
 * `/admin` 配下 (#48-C layout で認証) + 本ページで `QUIET_HOURS_ROLES` (school_admin / system_admin) に
 * 限定 (teacher は 403 → /forbidden、V1 class-settings の school_admin gate に整合)。別テナントのクラスは
 * RLS 不可視 → 404。クラス可視確認 + 既存設定読みを 1 つの `withSession` の自校 RLS tx 内でまとめて行う。
 */
export default async function ClassQuietHoursPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  await requireRole(QUIET_HOURS_ROLES);
  const { classId } = await params;

  const data = await withSession(
    async (tx) => {
      const cls = await findVisibleClass(tx, classId);
      if (!cls) {
        return null;
      }
      const value = await getClassConfigValue(tx, classId, QUIET_HOURS_KIND);
      return { className: cls.name, ranges: readQuietRanges(value) };
      // tenantScoped: system_admin を降格し full_access policy の全校発火を止める (他校 class の可視化を防ぐ、
      // ADR-019 §#95)。write 側 (quiet-hours-actions) と同規律で read も自校に限定する。
    },
    { tenantScoped: true },
  );

  // クラスが自校で不可視 (別テナント / 存在しない) なら 404。
  if (!data) {
    notFound();
  }

  return (
    <div>
      <Link href={`/admin/editor/${classId}`} style={{ fontSize: "0.85rem", color: "#2563eb" }}>
        ← {data.className} の編集へ戻る
      </Link>
      <h1 style={{ fontSize: "1.4rem", margin: "0.5rem 0 0.25rem" }}>
        {data.className} の静粛時間
      </h1>
      <p style={{ color: "#6b7280", margin: "0 0 1rem", fontSize: "0.9rem" }}>
        サイネージを静音 /
        非表示にする時間帯を設定します。設定した時間帯はサイネージ表示に反映されます。
      </p>
      <QuietHoursManager scope="class" targetId={classId} initialRanges={data.ranges} />
    </div>
  );
}
