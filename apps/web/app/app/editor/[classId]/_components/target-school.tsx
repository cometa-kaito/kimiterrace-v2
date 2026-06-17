"use client";

import { setAssignmentsAction, setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import { createContext, useContext, useMemo } from "react";

/**
 * daily_data 3 アクション (予定 / 連絡 / 提出物) の **対象校スコープ配線** (C2、ads の AdsManager と同型)。
 *
 * system_admin が `/ops/schools/{id}/editor/{classId}` から他校のクラスを編集する経路でのみ `schoolId` を
 * 供給する。`ScheduleEditor` / `NoticeEditor` / `AssignmentEditor` は {@link useScopedDailyDataActions} を
 * 経由して各 Server Action を呼ぶ。
 *
 * - `/app` 経路 (school_admin / teacher): Provider を置かない → context は `undefined` → 各 action の
 *   末尾引数 `targetSchoolId` に `undefined` が渡る (= 自校・従来動作・回帰なし)。
 * - `/ops` 経路 (system_admin): `TargetSchoolProvider` で `schoolId` を供給 → 各 action にそれを結ぶ。
 *   越境のゲートはサーバ側 (`toScopedEditorActor` / `withSession` の `tenantScoped`) が担う (C1 #1007)。
 */
const TargetSchoolContext = createContext<string | undefined>(undefined);

/** 対象校 (system_admin /ops 経路) を配下のエディタへ供給する薄い Provider。未指定なら自校 (従来)。 */
export function TargetSchoolProvider({
  schoolId,
  children,
}: {
  /** system_admin が特定校を編集する /ops 経路でのみ指定。未指定なら自校 (従来動作)。 */
  schoolId?: string;
  children: React.ReactNode;
}) {
  return <TargetSchoolContext.Provider value={schoolId}>{children}</TargetSchoolContext.Provider>;
}

/**
 * daily_data 3 アクションを対象校付きで返す。context が `undefined` (=/app 経路) なら末尾引数も `undefined`
 * となり、各 action は従来どおり自校に固定される (回帰なし)。`schoolId` 指定時 (=/ops 経路) のみ対象校を結ぶ。
 *
 * 各関数は `setXxxAction(scope, targetId, date, items)` と**同一シグネチャ**を保ち、`targetSchoolId` だけを
 * 内部で付与する。これによりエディタ側の呼び出し (`save: (toSave) => setScheduleAction(...)`) を最小差分で
 * 置き換えられる。
 */
export function useScopedDailyDataActions() {
  const targetSchoolId = useContext(TargetSchoolContext);
  return useMemo(
    () => ({
      setSchedule: (
        scope: Parameters<typeof setScheduleAction>[0],
        targetId: Parameters<typeof setScheduleAction>[1],
        date: Parameters<typeof setScheduleAction>[2],
        items: Parameters<typeof setScheduleAction>[3],
      ) => setScheduleAction(scope, targetId, date, items, targetSchoolId),
      setNotices: (
        scope: Parameters<typeof setNoticesAction>[0],
        targetId: Parameters<typeof setNoticesAction>[1],
        date: Parameters<typeof setNoticesAction>[2],
        items: Parameters<typeof setNoticesAction>[3],
      ) => setNoticesAction(scope, targetId, date, items, targetSchoolId),
      setAssignments: (
        scope: Parameters<typeof setAssignmentsAction>[0],
        targetId: Parameters<typeof setAssignmentsAction>[1],
        date: Parameters<typeof setAssignmentsAction>[2],
        items: Parameters<typeof setAssignmentsAction>[3],
      ) => setAssignmentsAction(scope, targetId, date, items, targetSchoolId),
    }),
    [targetSchoolId],
  );
}
