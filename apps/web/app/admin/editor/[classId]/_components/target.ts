import type { EditorTarget } from "@/lib/editor/schedule-core";

/**
 * 編集コンポーネントの prop (`target` / 後方互換の `classId`) を 1 つの `EditorTarget` に解決する。
 * `target` があればそれを優先し、無ければ `classId` を class target に詰める。両方無いのは呼び出し側の
 * バグなので throw する (型上は到達しないが、防御的に明示)。
 */
export function toEditorTarget(
  target: EditorTarget | undefined,
  classId: string | undefined,
): EditorTarget {
  if (target) {
    return target;
  }
  if (classId) {
    return { scope: "class", classId };
  }
  throw new Error("ScheduleEditor/NoticeEditor/AssignmentEditor requires target or classId");
}
