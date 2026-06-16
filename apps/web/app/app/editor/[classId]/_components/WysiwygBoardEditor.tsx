"use client";

import type { EditRegion } from "@/app/(signage)/signage/[classToken]/_components/BoardRegionEditButton";
import { ScaledSignageBoard } from "@/app/(signage)/signage/[classToken]/_components/ScaledSignageBoard";
import { type EditorBoardBase, buildEditorPreviewPayload } from "@/lib/editor/editor-board-preview";
import type { AssignmentItem, NoticeItem } from "@/lib/editor/notice-assignment-core";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { useCallback, useMemo, useRef, useState } from "react";
import { AssignmentEditor } from "./AssignmentEditor";
import { NoticeEditor } from "./NoticeEditor";
import { ScheduleEditor } from "./ScheduleEditor";
import styles from "./WysiwygBoardEditor.module.css";

/**
 * クラスエディタ「盤面を編集」タブの **WYSIWYG（実レイアウト上のライブプレビュー連動）編集器**（PR・B）。
 *
 * ## 採用 UX: ライブプレビュー + 領域クリックの contextual エディタ（連動プレビュー）
 * 上段に**実機サイネージと同一レイアウト**（{@link ScaledSignageBoard} = `SignageBoardView` を 16:9・1280×720 で
 * 縮小描画）の**大きなライブプレビュー**を出し、教員が「50 インチ TV にどう出るか」を見ながら編集できる。盤面上の
 * 各領域（予定 / 連絡 / 提出物）はクリック可能で、押すと下のエディタへスクロール + フォーカスし、対応エディタを
 * ハイライトする。プレビューは編集に**即時連動**する（下の各エディタの `onItemsChange` で下書きを集約 → payload を
 * 再合成 → 盤面を再描画）。
 *
 * **完全インライン編集（盤面のセル内に直接入力）ではなく連動プレビューを採った理由**: タスクが許容する現実的
 * スコープ判断に従い、(1) 既存の保存・検証・自動保存・scope・RLS/監査を担う `ScheduleEditor` / `NoticeEditor` /
 * `AssignmentEditor` を**そのまま温存**（保存配線を一切作り替えない＝教員の編集が壊れない最優先）、(2) 盤面は
 * 実機 `SignageBoardView` を**重複実装せず再利用**、(3) 1 PR ≤500 行（ルール6）に収める、ため。盤面はクライアントの
 * `transform: scale()` で縮小されるため、その中に入力欄を置くとフォーカス・IME・タップ判定が崩れやすい（縮小座標系の
 * 既知の落とし穴）。連動プレビューはこの不安定要素を避けつつ「実配置を見ながら編集」を満たす。
 *
 * ## 保存ロジック温存（最重要）
 * 各エディタは従来どおり自前で state・自動保存・検証を持ち、`onItemsChange`（**追加・観測専用の prop**）で現在の
 * 保存ペイロード相当だけを親へ通知する。親はそれをプレビュー描画に使うだけで、保存・RLS・監査には一切関与しない
 * （データ非破壊・既存挙動温存）。検証前の生値が来ても盤面整形（`section-format.ts`）が fail-soft で受ける。
 *
 * ## レスポンシブ
 * スマホ（≤899px）はプレビューを畳み、従来の縦積みフォーム編集に倒す（タスク指示: スマホは現行 UI のままで良い）。
 */
// 領域識別子は盤面の編集ボタンと**単一ソース**を共有する（`EditRegion`）。ここで再定義してドリフトさせない。
type Region = EditRegion;

export function WysiwygBoardEditor({
  classId,
  date,
  base,
  initialSchedules,
  initialNotices,
  initialAssignments,
}: {
  classId: string;
  date: string;
  /**
   * サーバ（RLS 文脈内）で取得した盤面の基底スナップショット（広告・天気・クラス文脈・パターン・他日付の予定等）。
   * 取得不能（クラス不可視等）の場合は `null` で、ライブプレビュー（盤面）を出さず従来の縦積みフォームのみに
   * フォールバックする（盤面を壊さない・編集は引き続き可能）。
   */
  base: EditorBoardBase | null;
  initialSchedules: ScheduleItem[];
  initialNotices: NoticeItem[];
  initialAssignments: AssignmentItem[];
}) {
  // ライブプレビュー用の下書き集約。各エディタの onItemsChange で更新され、盤面再描画のみに使う（保存は各エディタ）。
  const [schedules, setSchedules] = useState<ScheduleItem[]>(initialSchedules);
  const [notices, setNotices] = useState<NoticeItem[]>(initialNotices);
  const [assignments, setAssignments] = useState<AssignmentItem[]>(initialAssignments);
  // どの領域を編集中か（プレビューの枠 + エディタカードのハイライトを連動させる）。
  const [active, setActive] = useState<Region | null>(null);

  // onItemsChange は安定参照にする（エディタ側の useEffect 依存に入るため、毎回新規だと無限ループになる）。
  const onSchedules = useCallback((items: ScheduleItem[]) => setSchedules(items), []);
  const onNotices = useCallback((items: NoticeItem[]) => setNotices(items), []);
  const onAssignments = useCallback((items: AssignmentItem[]) => setAssignments(items), []);

  // 編集器カードへの参照（領域クリックでスクロール + 内部の最初の入力へフォーカス）。ref は安定参照。
  const scheduleRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const assignmentRef = useRef<HTMLDivElement>(null);

  const focusRegion = useCallback((region: Region) => {
    setActive(region);
    const card =
      region === "schedules"
        ? scheduleRef.current
        : region === "notices"
          ? noticeRef.current
          : assignmentRef.current;
    if (!card) {
      return;
    }
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    // カード内の最初のフォーカス可能要素（入力欄）へフォーカス（無ければカード自体は素通り）。
    const focusable = card.querySelector<HTMLElement>(
      "input, select, textarea, button:not([disabled])",
    );
    focusable?.focus({ preventScroll: true });
  }, []);

  // 下書きから実機 payload を合成（純関数）。編集のたび再合成され盤面が即時更新される。base が無ければ盤面は出さない。
  const previewPayload = useMemo(
    () => (base ? buildEditorPreviewPayload(base, { schedules, notices, assignments }) : null),
    [base, schedules, notices, assignments],
  );

  return (
    <div className={styles.root}>
      {previewPayload ? (
        <>
          <p className={styles.hint}>
            サイネージ（教室の 50
            インチ画面）にどう出るかを見ながら編集できます。盤面の領域をクリックすると、その項目の
            編集欄に移動します。広告は編集できません（広告管理で設定）。
          </p>

          {/* 上段: 実機と同一レイアウトのライブプレビュー（≤899px では非表示）。クリック対象は盤面の**実セクション
              そのもの**（Approach A）。`editRegions` を渡すと `SignageBoardView` が予定 / 連絡 / 提出物の実 `<section>` を
              `position:relative` 化して `inset:0` の編集ボタンを内側に敷く＝実描画要素を覆うので％近似のズレが原理的に
              起きない（旧・別レイヤーの％オーバーレイを廃止）。盤面内部の装飾見出し / region 名は編集モードで AT から
              外れ、操作名は編集ボタンの aria-label が担うので、編集器側の見出し・既存 e2e の strict locator と二重化
              しない。盤面のテキストは下の編集器に等価で出るのでスクリーンリーダ利用者が情報を失わない。 */}
          <div className={styles.canvas}>
            <ScaledSignageBoard
              payload={previewPayload}
              editRegions={{ active, onRegion: focusRegion }}
            />
          </div>
        </>
      ) : null}

      {/* 下段: 既存の各セクションエディタ（保存・検証・自動保存・RLS/監査はここが温存して担う）。 */}
      <div className={styles.editors}>
        <EditorCard
          title="予定"
          cardRef={scheduleRef}
          active={active === "schedules"}
          onFocusCapture={() => setActive("schedules")}
        >
          <ScheduleEditor
            classId={classId}
            date={date}
            initialItems={initialSchedules}
            onItemsChange={onSchedules}
          />
        </EditorCard>
        <EditorCard
          title="連絡"
          cardRef={noticeRef}
          active={active === "notices"}
          onFocusCapture={() => setActive("notices")}
        >
          <NoticeEditor
            classId={classId}
            date={date}
            initialItems={initialNotices}
            onItemsChange={onNotices}
          />
        </EditorCard>
        <EditorCard
          title="提出物"
          cardRef={assignmentRef}
          active={active === "assignments"}
          onFocusCapture={() => setActive("assignments")}
        >
          <AssignmentEditor
            classId={classId}
            date={date}
            initialItems={initialAssignments}
            onItemsChange={onAssignments}
          />
        </EditorCard>
      </div>
    </div>
  );
}

/** 編集器を包むカード。選択中はハイライトし、内部入力にフォーカスが入ったら領域を選択状態にする。 */
function EditorCard({
  title,
  cardRef,
  active,
  onFocusCapture,
  children,
}: {
  title: string;
  cardRef: React.RefObject<HTMLDivElement | null>;
  active: boolean;
  onFocusCapture: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      ref={cardRef}
      className={`${styles.editorCard} ${active ? styles.editorCardActive : ""}`}
      onFocusCapture={onFocusCapture}
    >
      <h2 className={styles.editorCardTitle}>{title}</h2>
      {children}
    </section>
  );
}
