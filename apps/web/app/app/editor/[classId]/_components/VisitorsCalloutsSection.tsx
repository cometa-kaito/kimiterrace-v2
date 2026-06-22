"use client";

import type { ClassVisitor, StudentCallout } from "@kimiterrace/db";
import { CalloutsEditor } from "./CalloutsEditor";
import { VisitorsEditor } from "./VisitorsEditor";
import boardLayout from "./board-layout.module.css";

/**
 * 来校者一覧 / 生徒呼び出しの編集セクション（pattern2/3 専用ブロック）。盤面の下に 2 カラムで出す。
 *
 * ## なぜ独立コンポーネントにしたか（バグ修正の本丸）
 * 旧実装は親（`page.tsx`）が `VisitorsEditor` と `CalloutsEditor` を**同じ `key={date}`** で隣接して
 * 並べていた。React の keyed reconciliation は**同一親内の兄弟で key が衝突**すると挙動が未定義になり、
 * 対象日（`?date=` ソフトナビ）を変えた瞬間に「来校者一覧」が複製され「生徒呼び出し」が下へ押し出される、
 * という実バグが本番（6/21→6/22）で再現した。コードの静的読みでは「key={date} だから複製しない」と誤結論
 * したが、**衝突キーが原因**＝実画面が裁判官だった。
 *
 * 修正方針: 各エディタに**衝突しない安定キー**（`visitors-*` / `callouts-*`）を与える。日付変更時に新日付の
 * データで初期化する目的（旧 `key={date}` の意図）は、`date` を含めることで維持する（`visitors-${date}` /
 * `callouts-${date}`）＝対象日切替時の「中身が変更先の日付に移る」混線も従来どおり防げる。
 *
 * 表示・保存・検証・RLS/監査は各エディタ（`VisitorsEditor` / `CalloutsEditor`）が温存して担う。本コンポーネントは
 * **配置と key 付与のみ**で、データには一切関与しない。盤面のパターン選択（`showVisitors` / `showCallouts`）は
 * 親が `patternIncludesBlock` 単一ソースで決めた値をそのまま受け取るだけで、ここでは増減させない。
 */
export function VisitorsCalloutsSection({
  classId,
  date,
  showVisitors,
  showCallouts,
  visitors,
  callouts,
}: {
  classId: string;
  date: string;
  showVisitors: boolean;
  showCallouts: boolean;
  visitors: ClassVisitor[] | null;
  callouts: StudentCallout[] | null;
}) {
  if (!(showVisitors || showCallouts)) {
    return null;
  }
  return (
    <div className={boardLayout.grid} style={{ marginTop: "1rem" }}>
      {showVisitors && visitors ? (
        // 兄弟間で衝突しない安定キー（旧 key={date} の衝突が複製バグの原因）。date を含め日付変更で再マウントする。
        <VisitorsEditor
          key={`visitors-${date}`}
          classId={classId}
          date={date}
          initialItems={visitors}
        />
      ) : null}
      {showCallouts && callouts ? (
        <CalloutsEditor
          key={`callouts-${date}`}
          classId={classId}
          date={date}
          initialItems={callouts}
        />
      ) : null}
    </div>
  );
}
