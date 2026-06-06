import { isUuid } from "@/lib/editor/schedule-core";
import { notFound } from "next/navigation";
import { ScopeEditorView } from "../../ScopeEditorView";

/**
 * 学科全体エディタ (段A-2)。指定学科スコープ (`daily_data.scope='department'`) の時間割 / 連絡 / 提出物を
 * 編集する。別テナント / 不在の学科 id は RLS 経由で `ScopeEditorView` が 404。
 */
export default async function DepartmentScopeEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) {
    notFound();
  }
  return (
    <ScopeEditorView
      target={{ scope: "department", departmentId: id }}
      searchParams={searchParams}
    />
  );
}
