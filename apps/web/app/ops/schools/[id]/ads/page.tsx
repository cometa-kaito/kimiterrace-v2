import { ClassPickerPage } from "../_components/ClassPickerPage";

/**
 * F10 / #46: **system_admin（運営）の広告掲載導線** (`/ops/schools/{id}/ads`)。**Server Component**。
 *
 * 運営が広告（広告主の素材）を表示する**クラスを選ぶ**ための一覧。各クラスの「広告管理」へ導き、
 * そこで入稿（メディアURL）/ タップリンク / 表示秒数 を設定する（クラス別広告管理ページは ADS_ROLES =
 * school_admin / system_admin で system_admin も操作可。これまで運営側に到達導線が無かったのを補う）。
 *
 * 認可・データ取得・一覧描画は共通の {@link ClassPickerPage}（4 導線で同一）に集約。本ページは
 * 見出しの語 / サブ説明 / 行ラベル / 遷移先パス を渡す薄いラッパ。
 */
export default async function SchoolAdPlacementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <ClassPickerPage
      schoolId={id}
      title="広告掲載"
      subtitle={
        <>
          広告を表示するクラスを選び、「広告管理」で素材（メディアURL）・タップ時のリンク・表示秒数を
          設定します。学校 / 学科 / 学年への一括掲載は今後対応します（現状はクラス単位）。
        </>
      }
      classLinkLabel="広告管理 →"
      classHref={(classId) => `/ops/schools/${id}/ads/${classId}`}
    />
  );
}
