import { ClassPickerPage } from "../_components/ClassPickerPage";

/**
 * **system_admin（運営）の daily_data エディタ導線** (`/ops/schools/{id}/editor`)。**Server Component**。
 * `/ops/schools/{id}` の「エディタ」からの遷移先 (C2)。
 *
 * 運営が予定 / 連絡 / 提出物を編集する**クラスを選ぶ**ための一覧。各クラスの「エディタ」へ導く。編集は
 * クラス別ページ `/ops/schools/{id}/editor/{classId}` で行い、daily_data 3 action を対象校に降格スコープして
 * 書く (C1 #1007 backend)。広告掲載 #46 / 生徒アクセスリンク #1004 と同型の class picker。学校全体 / 学科 /
 * 学年 scope のエディタは後続 PR (C3)。
 *
 * 認可・データ取得・一覧描画は共通の {@link ClassPickerPage}（4 導線で同一）に集約。本ページは
 * 見出しの語 / サブ説明 / 行ラベル / 遷移先パス を渡す薄いラッパ。
 */
export default async function SchoolEditorClassPickerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <ClassPickerPage
      schoolId={id}
      title="エディタ"
      subtitle={
        <>
          予定 / 連絡 / 提出物を編集するクラスを選びます。学校 / 学科 /
          学年への一括編集は今後対応します（現状はクラス単位）。
        </>
      }
      classLinkLabel="エディタ →"
      classHref={(classId) => `/ops/schools/${id}/editor/${classId}`}
    />
  );
}
