"use client";

import type { SignageDesignPattern } from "@/lib/signage/design-pattern";
import { blockRowCapacity } from "@/lib/signage/pattern-blocks";
import type { ClassVisitor, StudentCallout } from "@kimiterrace/db";
import { CalloutsEditor } from "./CalloutsEditor";
import { VisitorsEditor } from "./VisitorsEditor";
import boardLayout from "./board-layout.module.css";
import { editorRegionAnchorId } from "./region-anchor";

/**
 * 来校者一覧 / 生徒呼び出しの編集セクション（pattern2/3 専用ブロック）。盤面の下に 2 カラムで出す。
 *
 * ## なぜ独立コンポーネントにしたか（バグ修正の本丸）
 * 旧実装は親（`page.tsx`）が `VisitorsEditor` と `CalloutsEditor` を**同じ `key={date}`** で、しかも
 * それぞれ `showVisitors && …` / `showCallouts && …` の**条件付き短絡で同一親に隣接**させて並べていた。
 * この「同一親・隣接・条件付きレンダリング＋兄弟で同じ key」という配置のとき、対象日（`?date=` ソフトナビ＝
 * 同一ページ再レンダ）で `date` を変えると「来校者一覧」が複製され「生徒呼び出し」が下へ押し出される、という
 * 実バグが本番（6/21→6/22）で観測された（衝突 key に戻すと手元でも再現・回帰テストで固定済）。
 * ※ React の内部仕様としては「型＋位置で照合」されるため、異なる型の兄弟が同じ key を持つこと自体は通常は
 *   問題にならない。ここで複製したのは上記の特定配置での rerender 時に観測された挙動であり、断定的な一般則
 *   （「key が被ると未定義」）として記録しない。観測事実に留める。
 *
 * 修正方針: 各エディタに**衝突しない安定キー**（`visitors-*` / `callouts-*`）を与える。日付変更時に新日付の
 * データで初期化する目的（旧 `key={date}` の意図）は、`date` を含めることで維持する（`visitors-${date}` /
 * `callouts-${date}`）＝対象日切替時の「中身が変更先の日付に移る」混線も従来どおり防げる。
 *
 * 表示・保存・検証・RLS/監査は各エディタ（`VisitorsEditor` / `CalloutsEditor`）が温存して担う。本コンポーネントは
 * **配置と key 付与のみ**で、データには一切関与しない。盤面のパターン選択（`showVisitors` / `showCallouts`）は
 * 親が `patternIncludesBlock` 単一ソースで決めた値をそのまま受け取るだけで、ここでは増減させない。
 *
 * ## 盤面との空間対応（finding #12）＋ 盤面クリックのジャンプ先（finding #2）
 * 盤面（`SignageBoardView` の pattern2/3）は **生徒呼び出し（左）→ 来校者一覧（右）** の順で 2 カラムに並ぶ。
 * 編集欄もこの左右順に合わせる（旧実装は来校者→呼び出しで盤面と左右が逆だった＝空間対応の崩れ・#12）。
 * また各エディタを `editorRegionAnchorId` の DOM id を持つラッパで囲む。盤面の来校者/呼び出しをクリックすると
 * `WysiwygBoardEditor.focusRegion` がこの id を `getElementById` して該当編集欄へスクロール + フォーカスする
 * （#2 の盤面クリック全配線）。id 付与をラッパに置くことで、各エディタ本体（VisitorsEditor / CalloutsEditor）は
 * 無改修のまま（他レーンの編集と衝突しない）。
 */
export function VisitorsCalloutsSection({
  classId,
  date,
  pattern,
  showVisitors,
  showCallouts,
  visitors,
  callouts,
  anchored = true,
}: {
  classId: string;
  date: string;
  /** このクラスの実機が出すデザインパターン。来校者/呼び出しの事前生成行数（盤面の規定枠）を引くのに使う。 */
  pattern: SignageDesignPattern;
  showVisitors: boolean;
  showCallouts: boolean;
  visitors: ClassVisitor[] | null;
  callouts: StudentCallout[] | null;
  /**
   * 盤面クリックのジャンプ先 anchor id（`editor-region-*`）を付けるか。既定 true（今日の編集＝盤面あり）。
   * 「選択した日の編集」は盤面なし（showBoard=false で盤面クリックが無い）なので false にし、同一 id を
   * 今日のセクションと二重に持たない（Reviewer 指摘・要望 2026-06-23）。
   */
  anchored?: boolean;
}) {
  if (!(showVisitors || showCallouts)) {
    return null;
  }
  // 盤面の規定枠ぶん空行を事前生成する数（単一ソース {@link blockRowCapacity}）。空行は保存・自動保存判定・
  // 並べ替えハンドルから除外されるので、埋めなくても保存をブロックしない（各エディタの isBlank*Row）。
  const calloutPrefill = blockRowCapacity(pattern, "callout");
  const visitorPrefill = blockRowCapacity(pattern, "visitor");
  return (
    <div className={boardLayout.grid} style={{ marginTop: "1rem" }}>
      {/* 盤面（pattern2/3）と同じ左右順: 生徒呼び出し（左）→ 来校者一覧（右）。各エディタは盤面クリックの
          ジャンプ先になるよう anchor id 付きのラッパで囲む（id はラッパに置き、エディタ本体は無改修に保つ）。
          兄弟間で衝突しない安定キー（callouts-* / visitors-*）を維持し、date を含めて日付変更で再マウントする
          （新日付データで初期化する旧 key={date} の意図を維持・複製バグの回帰ガードと整合）。 */}
      {showCallouts && callouts ? (
        <div
          key={`callouts-${date}`}
          id={anchored ? editorRegionAnchorId("callouts") : undefined}
          className={boardLayout.card}
        >
          <CalloutsEditor
            classId={classId}
            date={date}
            initialItems={callouts}
            prefillRows={calloutPrefill}
          />
        </div>
      ) : null}
      {showVisitors && visitors ? (
        <div
          key={`visitors-${date}`}
          id={anchored ? editorRegionAnchorId("visitors") : undefined}
          className={boardLayout.card}
        >
          <VisitorsEditor
            classId={classId}
            date={date}
            initialItems={visitors}
            prefillRows={visitorPrefill}
          />
        </div>
      ) : null}
    </div>
  );
}
