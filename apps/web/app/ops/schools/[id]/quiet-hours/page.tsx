import { ClassPickerPage } from "../_components/ClassPickerPage";

/**
 * **system_admin（運営）の静粛時間 設定導線** (`/ops/schools/{id}/quiet-hours`)。**Server Component**。
 * 広告掲載導線 (`/ops/schools/{id}/ads`、#46/#1002) と対称で、運営が静粛時間を設定する**クラスを選ぶ**
 * ための一覧。各クラスの「静粛時間」へ導き、そこでサイネージを静音 / 非表示にする時間帯を設定する
 * (クラス別静粛時間ページは QUIET_HOURS_ROLES = school_admin / system_admin で system_admin も操作可)。
 *
 * 認可・データ取得・一覧描画は共通の {@link ClassPickerPage}（4 導線で同一）に集約。本ページは
 * 見出しの語 / サブ説明 / 行ラベル / 遷移先パス を渡す薄いラッパ。
 */
export default async function SchoolQuietHoursPickerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <ClassPickerPage
      schoolId={id}
      title="静粛時間"
      subtitle={
        <>
          サイネージを静音 / 非表示にする時間帯を設定するクラスを選びます。学校 / 学科 /
          学年への一括設定は 今後対応します（現状はクラス単位）。
        </>
      }
      classLinkLabel="静粛時間 →"
      classHref={(classId) => `/ops/schools/${id}/quiet-hours/${classId}`}
    />
  );
}
