import { requireRole } from "@/lib/auth/guard";
import { EDITOR_ROLES, isUuid } from "@/lib/editor/schedule-core";
import { notFound } from "next/navigation";
import { ScopeEditorView } from "../../ScopeEditorView";

/**
 * 学年全体エディタ (段A-2)。指定学年スコープ (`daily_data.scope='grade'`) の予定 / 連絡 / 提出物を
 * 編集する。別テナント / 不在の学年 id は RLS 経由で `ScopeEditorView` が 404。
 */
export default async function GradeScopeEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  // ページ本体でも委譲先 View と同じ集合で明示ガード (多層防御・棚卸し耐性)。
  await requireRole(EDITOR_ROLES);
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  return <ScopeEditorView target={{ scope: "grade", gradeId: id }} searchParams={searchParams} />;
}
