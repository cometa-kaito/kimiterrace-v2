import { ClassPickerPage } from "../_components/ClassPickerPage";

/**
 * F05: **system_admin（運営）の生徒アクセスリンク（magic link）導線** (`/ops/schools/{id}/magic-link`)。
 * **Server Component**。`/ops/schools/{id}` の「生徒アクセスリンク」からの遷移先。
 *
 * 運営がリンクを発行・失効する**クラスを選ぶ**ための一覧。各クラスの「リンク管理」へ導く。発行 API
 * (`POST /api/magic-links`) は MAGIC_LINK_ISSUER_ROLES（school_admin / system_admin）で system_admin も
 * 操作可（対象クラスから学校を cross-tenant 解決し `system_admin_full_access` 下で発行・監査 actor は null）。
 * これまで運営側に到達導線が無かったのを補う（広告掲載 #46 と同型の class picker）。
 *
 * 認可・データ取得・一覧描画は共通の {@link ClassPickerPage}（4 導線で同一）に集約。本ページは
 * 見出しの語 / サブ説明 / 行ラベル / 遷移先パス を渡す薄いラッパ。
 */
export default async function SchoolMagicLinkPlacementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <ClassPickerPage
      schoolId={id}
      title="生徒アクセスリンク"
      subtitle={
        <>
          リンクを発行するクラスを選び、「リンク管理」で生徒 / サイネージ用の magic link
          を発行・失効します。発行時に表示される URL はその場限りです（後から再表示できません）。
        </>
      }
      classLinkLabel="リンク管理 →"
      classHref={(classId) => `/ops/schools/${id}/magic-link/${classId}`}
    />
  );
}
