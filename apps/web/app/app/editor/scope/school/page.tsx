import { requireRole } from "@/lib/auth/guard";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { ScopeEditorView } from "../ScopeEditorView";

/**
 * 学校全体エディタ (段A-2)。学校全体スコープ (`daily_data.scope='school'`) の予定 / 連絡 / 提出物を
 * 編集する。ここで保存した内容は、クラス個別入力が無いクラスのサイネージに共通で表示される。
 */
export default async function SchoolScopeEditorPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  // ページ本体でも委譲先 View と同じ集合で明示ガード (多層防御・棚卸し耐性、app/app/page.tsx と同方針)。
  await requireRole(EDITOR_ROLES);
  return <ScopeEditorView target={{ scope: "school" }} searchParams={searchParams} />;
}
