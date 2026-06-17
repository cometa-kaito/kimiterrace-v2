import { Breadcrumb } from "@/app/_components/Breadcrumb";
import { AssignmentEditor } from "@/app/app/editor/[classId]/_components/AssignmentEditor";
import { NoticeEditor } from "@/app/app/editor/[classId]/_components/NoticeEditor";
import { ScheduleEditor } from "@/app/app/editor/[classId]/_components/ScheduleEditor";
import { TargetSchoolProvider } from "@/app/app/editor/[classId]/_components/target-school";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { getEditorTargetData } from "@/lib/editor/daily-data-read";
import { isValidDate } from "@/lib/editor/schedule-core";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { isUuid } from "@/lib/system-admin/schools-core";
import { findVisibleClass, getSchoolDetail } from "@kimiterrace/db";
import { notFound } from "next/navigation";

/**
 * システム管理者が**特定校の特定クラス**の daily_data (予定 / 連絡 / 提出物) を編集する画面
 * (`/ops/schools/{id}/editor/{classId}`)。**Server Component**。`/ops/schools/{id}/editor` のクラス選択
 * からの遷移先 (ads #1002 / magic-link #1004 と同型の class-first 導線)。
 *
 * **認可**: `/ops` layout の `requireRole(ADMIN_ROLES)` に加え `requireRole(SYSTEM_ADMIN_ROLES)`
 * (system_admin のみ。school_admin / teacher は自校の `/app/editor/{classId}` を使う)。
 *
 * **対象校スコープ (ADR-019 §#95 / ads・magic-link の /ops 経路と同型・C1 #1007 backend 配線)**: 読み取りは
 * `withSession(..., { tenantScoped: true, schoolId })` の**対象校 RLS tx** で行い、actor (system_admin) を tx
 * 内で school_admin に降格して対象校以外を不可視にする (他校 class は 404)。編集 (保存) は各エディタが呼ぶ
 * daily_data 3 action に {@link TargetSchoolProvider} で `schoolId` を結び、対象校に降格スコープして書く
 * (`toScopedEditorActor` / `withSession` の `tenantScoped` がサーバ側ゲート。三系統 actor・FK 安全)。校名・存在
 * 確認は全校読取の `getSchoolDetail` で行い、不正 / 不存在 id は 404。
 *
 * **スコープ (C2)**: class のみ。学校全体 / 学科 / 学年 scope のエディタは後続 PR (C3)。AI チャット・来校者・
 * 呼び出し・黒画面は C1 backend が /ops 向けに開いていないため本画面では出さず、daily_data 3 セクションに絞る
 * (`/app` のクラスエディタの盤面プレビュー / FAB は対象校越え未対応のため流用しない)。
 */
const JST = "Asia/Tokyo";

export default async function SystemSchoolClassEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id, classId } = await params;
  if (!isUuid(id) || !isUuid(classId)) {
    notFound();
  }
  const { date: dateParam } = await searchParams;
  const date =
    dateParam && isValidDate(dateParam)
      ? dateParam
      : new Date().toLocaleDateString("en-CA", { timeZone: JST });

  // 校名・存在確認 (system_admin の全校読取、tenantScoped なし)。不存在 / 不可視は 404。
  const detail = await withSession((tx) => getSchoolDetail(tx, id)).catch(() => null);
  if (!detail) {
    notFound();
  }
  const { school } = detail;

  // 対象校に降格スコープした tx でクラス + daily_data 3 セクションを読む (他校 class は不可視 → 404)。
  const data = await withSession(
    async (tx) => {
      const cls = await findVisibleClass(tx, classId);
      if (!cls) {
        return null;
      }
      const editorData = await getEditorTargetData(tx, { scope: "class", classId }, date);
      if (!editorData) {
        return null;
      }
      return { className: cls.name, editorData };
    },
    { tenantScoped: true, schoolId: school.id },
  );

  // クラスが対象校に存在しない (別テナント / 不存在) なら 404。
  if (!data) {
    notFound();
  }
  const { className, editorData } = data;

  return (
    <div style={pageStyle}>
      <Breadcrumb
        items={[
          { label: "学校一覧", href: "/ops/schools" },
          { label: school.name, href: `/ops/schools/${school.id}` },
          { label: "エディタ", href: `/ops/schools/${school.id}/editor` },
          { label: className },
        ]}
      />

      <div role="note" style={bannerStyle}>
        <span aria-hidden="true">🛡</span>
        <span>
          <strong>
            システム管理者として「{school.name}」{className} を編集しています。
          </strong>
          <br />
          この学校のテナント範囲に限定され、予定 / 連絡 /
          提出物のすべての保存は監査ログに記録されます。
        </span>
      </div>

      <h1 style={titleStyle}>{className} のエディタ</h1>
      <p style={subtitleStyle}>
        このクラスのサイネージに表示する予定 / 連絡 /
        提出物を編集します。入力した時点で自動保存され、 配下のサイネージに即時反映されます。
      </p>

      {/* daily_data 3 アクションを対象校へ結ぶ Provider。配下の各エディタは useScopedDailyDataActions 経由で
          schoolId を末尾引数に渡す。/app 経路 (Provider 無し) は従来動作 (回帰なし)。
          key={editorData.date}: 対象日変更で各エディタを再マウントし新日付のデータで初期化する (旧日付の入力が
          残ったまま保存される混線バグの防止・/app クラスエディタと同根)。 */}
      <TargetSchoolProvider schoolId={school.id}>
        <div style={{ display: "grid", gap: "1rem" }}>
          <section style={cardStyle}>
            <h2 style={cardTitleStyle}>予定</h2>
            <ScheduleEditor
              key={editorData.date}
              classId={classId}
              date={editorData.date}
              initialItems={editorData.schedule}
            />
          </section>
          <section style={cardStyle}>
            <h2 style={cardTitleStyle}>連絡</h2>
            <NoticeEditor
              key={editorData.date}
              classId={classId}
              date={editorData.date}
              initialItems={editorData.notices}
            />
          </section>
          <section style={cardStyle}>
            <h2 style={cardTitleStyle}>提出物</h2>
            <AssignmentEditor
              key={editorData.date}
              classId={classId}
              date={editorData.date}
              initialItems={editorData.assignments}
            />
          </section>
        </div>
      </TargetSchoolProvider>
    </div>
  );
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
const cardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem 1.25rem",
};
const cardTitleStyle: React.CSSProperties = { fontSize: "1.05rem", margin: "0 0 0.5rem" };
