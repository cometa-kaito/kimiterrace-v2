import { ScopeEditorView } from "../ScopeEditorView";

/**
 * 学校全体エディタ (段A-2)。学校全体スコープ (`daily_data.scope='school'`) の予定 / 連絡 / 提出物を
 * 編集する。ここで保存した内容は、クラス個別入力が無いクラスのサイネージに共通で表示される。
 */
export default function SchoolScopeEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  return <ScopeEditorView target={{ scope: "school" }} searchParams={searchParams} />;
}
