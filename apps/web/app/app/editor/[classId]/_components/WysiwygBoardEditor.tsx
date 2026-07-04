"use client";

import type { EditRegion } from "@/app/(signage)/signage/[classToken]/_components/BoardRegionEditButton";
import { ScaledSignageBoard } from "@/app/(signage)/signage/[classToken]/_components/ScaledSignageBoard";
import { type EditorBoardBase, buildEditorPreviewPayload } from "@/lib/editor/editor-board-preview";
import type {
  AssignmentItem,
  NoticeItem,
  PinnedNoticeRow,
} from "@/lib/editor/notice-assignment-core";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { DEFAULT_SIGNAGE_DESIGN_PATTERN } from "@/lib/signage/design-pattern";
import { blockRowCapacity, patternIncludesBlock } from "@/lib/signage/pattern-blocks";
import { useAdRotation } from "@/lib/signage/useAdRotation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssignmentEditor } from "./AssignmentEditor";
import { NoticeEditor } from "./NoticeEditor";
import { PinnedNoticesList } from "./PinnedNoticesList";
import { ScheduleEditor } from "./ScheduleEditor";
import styles from "./WysiwygBoardEditor.module.css";
import { editorRegionAnchorId } from "./region-anchor";

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

/** previewPayload 未確定（base=null）時に {@link useAdRotation} へ渡す安定参照の空広告列（毎レンダーの再生成を避ける）。 */
const EMPTY_ADS: readonly never[] = [];

export function WysiwygBoardEditor({
  classId,
  date,
  base,
  initialSchedules,
  initialNotices,
  initialAssignments,
  pinnedNotices,
  showBoard = true,
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
  /**
   * 固定表示（pinned・F-C §5.4）を含むクラス直の連絡行（入力日つき・全期間）。連絡カード内に
   * 「固定中のお知らせ」一覧（{@link PinnedNoticesList}・対象日以外の固定行の削除導線）を出すために使う。
   * 未指定/空なら一覧は出さない（従来挙動・回帰なし）。
   */
  pinnedNotices?: PinnedNoticeRow[];
  /**
   * 盤面ライブプレビューを描くか。既定 true（今日の編集＝WYSIWYG）。false にすると盤面を出さず編集セクション
   * （予定/連絡/提出物）だけを出す＝「選択した日（未来）の編集」をフォームのみで軽く見せる用（要望 2026-06-23）。
   * パターン別の出し分け・保存・検証・自動保存は変わらない。
   */
  showBoard?: boolean;
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

  // プレビュー盤面の縮小率をコンテナ幅に合わせて**自動調整**する。盤面は 1280×720 固定を transform:scale で縮小
  // するが、CSS container-query（cqw）は文脈依存で効かない場合があり、原寸のまま枠に入って右・下が切れる事故が
  // 起きた（#967 後の盤面ラッパ変更で顕在化）。そこで枠の実幅を ResizeObserver で計測し、`ScaledSignageBoard` に
  // **明示 width** を渡して決定的に 16:9 に収める（cqw 非依存）。ウィンドウ/レイアウト変化にも追従する。
  const canvasRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const measure = () => setBoardWidth(el.clientWidth);
    measure();
    // ResizeObserver 非対応環境（jsdom テスト等）では 1 回の計測のみで打ち切る（throw 回避）。本番ブラウザでは
    // リサイズ/レイアウト変化に追従して縮小率を再調整する。
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 編集プレビューのヘッダー実時計を **live TV（SignageClient）と同じ作法**で動かす（マウント後のみ・1 秒刻み）。
  // SSR/初回は null＝時計なしで描き（ハイドレーション不一致を避ける）、マウント後に実時計を出して実盤面の
  // ヘッダーと一致させる（now の扱いの差を縮める）。これにより教員は「実機にどう出るか」をヘッダー込みで確認できる。
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // 盤面を描かない（showBoard=false の「選択した日」フォームのみ）ときは実時計を回さない（now は盤面でしか
    // 使わない・1Hz の空回り再描画を避ける・Reviewer 指摘）。
    if (!showBoard) {
      return;
    }
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [showBoard]);

  const focusRegion = useCallback((region: Region) => {
    setActive(region);
    // 予定/連絡/提出物 は本コンポーネント内の編集器（ref）。来校者/呼び出しは親（page.tsx）が盤面の**外（下）**に
    // 出す別セクションなので ref では届かず、DOM id（region-anchor 単一ソース）で参照して寄せる（finding #2 の全配線）。
    let card: HTMLElement | null = null;
    if (region === "schedules") {
      card = scheduleRef.current;
    } else if (region === "notices") {
      card = noticeRef.current;
    } else if (region === "assignments") {
      card = assignmentRef.current;
    } else if (typeof document !== "undefined") {
      // visitors | callouts — 盤面外の編集欄（VisitorsCalloutsSection が anchor id を付与）。
      card = document.getElementById(editorRegionAnchorId(region));
    }
    if (!card) {
      return;
    }
    // クリック後に「画面がバッと変わる」驚きを抑える: 移動距離を最小化（block:"nearest" で必要分だけ寄せる）し、
    // 視覚過敏設定（prefers-reduced-motion: reduce）の利用者にはアニメーションを切って瞬間移動にする（NFR05）。
    // scrollIntoView は jsdom 未実装なので任意呼び出し（テスト環境で throw しない）。
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
    // カード内の最初の**編集可能フィールド**（入力 / 選択）へフォーカスする。フォーカス自体はスクロールを
    // 誘発させない（preventScroll: true）= 上の滑らかな最小寄せだけが効く。
    // 操作ボタン（ドラッグ並べ替えハンドル / 削除）より編集欄を優先する: 行を事前生成すると連絡などが複数行に
    // なりハンドルが先頭の focusable になるため、ボタンに乗ると「クリックしてすぐ入力」を阻害する。ただし編集欄が
    // 一つも無いカード（例: 0 件の来校者/呼び出しで「追加」ボタンだけ）はそのボタンにフォールバックする
    // （操作の起点を失わない）。どちらも無ければ素通り。
    const focusable =
      card.querySelector<HTMLElement>("input, select, textarea") ??
      card.querySelector<HTMLElement>("button:not([disabled])");
    focusable?.focus({ preventScroll: true });
  }, []);

  // 下書きから実機 payload を合成（純関数）。編集のたび再合成され盤面が即時更新される。base が無ければ盤面は出さない。
  const previewPayload = useMemo(
    () => (base ? buildEditorPreviewPayload(base, { schedules, notices, assignments }) : null),
    [base, schedules, notices, assignments],
  );
  // 盤面プレビューでも実機と同じく広告を**ローテーション表示**する（要望 2026-06-23: エディタ画面でも広告が
  // 回るように）。回転 index の算出は実機（SignageClient）と同じ共有フック {@link useAdRotation} に寄せる。
  // 広告 0/1 件なら 0 のまま回らない・base 未取得（previewPayload=null）時は空配列で no-op。
  const adIndex = useAdRotation(previewPayload?.ads ?? EMPTY_ADS);

  // このクラスの実機が出すパターンに含まれる**編集対象ブロックだけ**を出す（`PATTERN_BLOCKS` 単一ソース駆動）。
  // 予定は pattern1/2/3 共通だが **pattern4 だけは予定を持たない**（教員入力最小・連絡のみ編集）ので、予定の
  // 編集欄も `patternIncludesBlock` で出し分ける（死セクション防止・finding① の対称ケース）。連絡 / 提出物も
  // 同様（pattern2/3 は盤面に出ず編集欄も出さない／pattern4 は連絡のみ出す）。来校者 / 生徒呼び出しは pattern2/3
  // 用で親（page.tsx）が盤面下に出し分ける。盤面取得不能（base=null）は既定 pattern1 に倒し従来の縦積みフォーム
  // （予定/連絡/提出物）を出す。
  const pattern = base?.designPattern ?? DEFAULT_SIGNAGE_DESIGN_PATTERN;
  const showSchedule = patternIncludesBlock(pattern, "schedule");
  const showNotice = patternIncludesBlock(pattern, "notice");
  const showAssignment = patternIncludesBlock(pattern, "assignment");
  // このクラスの実機が出すパターンの**規定枠ぶん**、各エディタに空行を事前生成させる（盤面に出る行数を入力前から
  // 提示する・2026-06-23 ユーザー要望）。値は単一ソース {@link blockRowCapacity}。空行は保存・自動保存判定から
  // 除外されるので埋めなくても保存をブロックしない（各エディタの isBlank*Row）。
  const schedulePrefill = blockRowCapacity(pattern, "schedule");
  const noticePrefill = blockRowCapacity(pattern, "notice");
  const assignmentPrefill = blockRowCapacity(pattern, "assignment");

  return (
    <div className={styles.root}>
      {showBoard && previewPayload ? (
        <>
          <p className={styles.hint}>
            実際の画面の見え方です。領域をクリックすると編集欄へ移動します。
          </p>

          {/* 上段: 実機と同一レイアウトのライブプレビュー（≤899px では非表示）。クリック対象は盤面の**実セクション
              そのもの**（Approach A）。`editRegions` を渡すと `SignageBoardView` が予定 / 連絡 / 提出物の実 `<section>` を
              `position:relative` 化して `inset:0` の編集ボタンを内側に敷く＝実描画要素を覆うので％近似のズレが原理的に
              起きない（旧・別レイヤーの％オーバーレイを廃止）。盤面内部の装飾見出し / region 名は編集モードで AT から
              外れ、操作名は編集ボタンの aria-label が担うので、編集器側の見出し・既存 e2e の strict locator と二重化
              しない。盤面のテキストは下の編集器に等価で出るのでスクリーンリーダ利用者が情報を失わない。 */}
          <div ref={canvasRef} className={styles.canvas}>
            {/* 枠の実幅を明示 width で渡し、cqw 非依存で確実に 16:9 へ収める（右・下のクリップ解消）。
                幅計測（ResizeObserver / マウント）が済むまでは盤面を出せないので、その間は真っ白な空箱ではなく
                スケルトンを敷く（LEDGER v2-ed-uo11: 読み込み中の "白い空箱" を解消）。 */}
            {boardWidth != null ? (
              <ScaledSignageBoard
                payload={previewPayload}
                width={boardWidth}
                editRegions={{ active, onRegion: focusRegion }}
                now={now}
                // 実機と同じく広告をローテーション表示（要望）。index は useAdRotation が duration 秒ごとに進める。
                adIndex={adIndex}
              />
            ) : (
              <div className={styles.skeleton} aria-hidden="true" />
            )}
          </div>
        </>
      ) : null}

      {/* 下段: 既存の各セクションエディタ（保存・検証・自動保存・RLS/監査はここが温存して担う）。 */}
      <div className={styles.editors}>
        {/* 予定は pattern1/2/3 の主役ブロックだが pattern4 は持たない（連絡のみ編集）ので出し分ける。 */}
        {showSchedule ? (
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
              showDateNav={false}
              prefillRows={schedulePrefill}
            />
          </EditorCard>
        ) : null}
        {showNotice ? (
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
              prefillRows={noticePrefill}
            />
            {/* 固定中のお知らせ（F-C §5.4）: 対象日以外の日に入力された pinned 行は上のエディタに出てこない
                （幽霊化）ため、連絡カード内に入力日つき一覧と削除導線を出す（受入基準 PR-C-2）。 */}
            {pinnedNotices && pinnedNotices.length > 0 ? (
              <PinnedNoticesList classId={classId} currentDate={date} rows={pinnedNotices} />
            ) : null}
          </EditorCard>
        ) : null}
        {showAssignment ? (
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
              prefillRows={assignmentPrefill}
            />
          </EditorCard>
        ) : null}
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
