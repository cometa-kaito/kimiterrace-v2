"use client";

import type { EditRegion } from "@/app/(signage)/signage/[classToken]/_components/BoardRegionEditButton";
import { ScaledSignageBoard } from "@/app/(signage)/signage/[classToken]/_components/ScaledSignageBoard";
import { useEditorDraftSyncRef } from "@/app/app/editor/_components/EditorDraftSyncContext";
import { editorPreviewPath } from "@/lib/editor/default-date";
import {
  type EditorBoardBase,
  type EditorBoardCarryover,
  buildEditorPreviewPayload,
} from "@/lib/editor/editor-board-preview";
import type {
  AssignmentItem,
  NoticeItem,
  PinnedNoticeRow,
} from "@/lib/editor/notice-assignment-core";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { DEFAULT_SIGNAGE_DESIGN_PATTERN } from "@/lib/signage/design-pattern";
import type { ClassVisitor, StudentCallout } from "@kimiterrace/db";
import {
  blockLabel,
  blockRowCapacity,
  editableBlocksForPattern,
  scheduleInputVariant,
} from "@/lib/signage/pattern-blocks";
import { useAdRotation } from "@/lib/signage/useAdRotation";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssignmentEditor } from "./AssignmentEditor";
import { NoticeEditor } from "./NoticeEditor";
import { PinnedNoticesList } from "./PinnedNoticesList";
import { ScheduleEditor } from "./ScheduleEditor";
import { VisitorsCalloutsSection } from "./VisitorsCalloutsSection";
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
 * ## レスポンシブ / 配置（配置最適化 2026-07-05・user-observed「スクロールしないと分からない/盤面が流れて消える」）
 * 広い PC（≥1240px）は盤面プレビューを左に **sticky 固定**し、編集セクション（予定/連絡/提出物 + 来校者/呼び出し）を
 * 右カラムで独立スクロールさせる 2 カラム（`.layout`/`.previewCol`/`.editorCol`・CSS）。結果を見失わず編集できる。
 * 中間幅（900–1239px）は従来どおり縦積み（プレビュー上／編集下）、スマホ（≤899px）はプレビューを畳み従来の縦積み
 * フォームに倒す。**編集できる範囲・保存・自動保存・クリックジャンプは一切不変**＝配置だけの最適化。
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
  previewPinnedNotices,
  previewCarryover,
  showBoard = true,
  showVisitors = false,
  showCallouts = false,
  visitors = null,
  callouts = null,
  dayHeader,
  planActions,
  dayEventsPanel,
  morningDraftCard,
  liveSignageUrl,
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
   * **対象日以外**の日に入力された・対象日に活性な pinned 項目（サーバで
   * `activePinnedNoticeItemsOutsideDate` が単一ソース `isNoticeActive` で抽出・入力日昇順・Reviewer
   * MEDIUM-2）。ライブプレビューの notices に draft の**前置き**で合成し、実 TV の窓マージ結果と一致させる
   * （実機に出ている校訓がプレビューで消える不一致の解消）。編集中は不変（固定行の増減は保存→再取得で反映）。
   */
  previewPinnedNotices?: NoticeItem[];
  /**
   * 他日入力の「持ち越し」項目（対象日に活性な 非 pinned 連絡・提出物。サーバで
   * `activeCarryoverItemsOutsideDate` が単一ソースの活性判定で抽出）。実 TV の窓マージ結果と一致させる
   * （2026-07-06 忠実度: 実機には出ている〆切持ち越しの提出物がプレビューで消える過少表示の是正）。
   * 編集中は不変（持ち越しの増減は保存→再取得で反映・previewPinnedNotices と同じ規律）。
   */
  previewCarryover?: EditorBoardCarryover;
  /**
   * 盤面ライブプレビューを描くか。既定 true（今日の編集＝WYSIWYG）。false にすると盤面を出さず編集セクション
   * （予定/連絡/提出物）だけを出す＝「選択した日（未来）の編集」をフォームのみで軽く見せる用（要望 2026-06-23）。
   * パターン別の出し分け・保存・検証・自動保存は変わらない。
   */
  showBoard?: boolean;
  /**
   * 来校者一覧 / 生徒呼び出し（pattern2/3 のブロック）を編集カラムに同居させるためのデータと出し分け。親
   * （page.tsx）が `patternIncludesBlock` 単一ソースで決めた `showVisitors` / `showCallouts` と、盤面 payload
   * 由来の `visitors` / `callouts` をそのまま渡す。既定は非表示（渡さないパターン・単体テストは従来どおり
   * 来校者/呼び出しを描かない）。実体の表示・保存・検証・RLS/監査・複製ガードは {@link VisitorsCalloutsSection}
   * が温存して担い、本コンポーネントは配置（編集カラム内）だけを与える（配置最適化 2026-07-05）。
   */
  showVisitors?: boolean;
  showCallouts?: boolean;
  visitors?: ClassVisitor[] | null;
  callouts?: StudentCallout[] | null;
  /**
   * 対象日セグメント（日付タブ）+「毎日の編集」見出し+「編集中: ◯月◯日」を、**盤面と同じ左パネル（sticky）に
   * 入れて一体で固定**するため親（page.tsx）から node で受け取る（ちらつき解消 2026-07-05・user 要望 #1: 日付タブが
   * static でスクロール消失し盤面だけ残る差分がちらつきの原因だった → 左パネルごと固定して差分ゼロに）。プレビューが
   * 無いフォールバック（base=null 等）では編集の上に素で全幅表示する（日付タブは常に見える必要がある）。
   */
  dayHeader?: React.ReactNode;
  /**
   * 計画系の即応操作（前日コピー / 前週コピー / 基本時間割リンク）を、**盤面プレビュー直下（左 sticky カラム内）**に
   * 常駐させるため親（page.tsx）から node で受け取る（FHD 配置最適化 2026-07-06）。左カラムは盤面の下が常に
   * 空白で、教員の最頻ワークフロー「昨日と同じ＋1ヶ所変更」がページ最下部（旧ゾーン2）まで往復していた摩擦を
   * 解消する。プレビューが無いフォールバック（base=null / showBoard=false）では編集セクションの上に全幅で出す
   * （操作を失わない）。実体（確認ダイアログ・?copied= 再ナビ・パターン別ラベル）は各ボタンが温存して担う。
   */
  planActions?: React.ReactNode;
  /**
   * 「この日の行事」パネル（{@link DayEventsPanel}・ADR-049 決定 7）。planActions と同じ理由で盤面プレビュー
   * 直下（左 sticky カラム内）に置くため親（page.tsx）から node で受け取る（行事の確認→ワンクリック確定が
   * 盤面を見ながらスクロールゼロで完結する）。行事 0 件の日は親が渡さない（何も描かない）。プレビューが無い
   * フォールバックでは planActions と同様に編集セクションの上へ全幅で出す（操作を失わない）。実体（既存
   * per-section 保存への append・?applied= 再ナビ）はパネル側が担い、本コンポーネントは配置だけを与える。
   */
  dayEventsPanel?: React.ReactNode;
  /**
   * 朝ドラフトカード（{@link MorningDraftCard}・P0・§3.1）。合成できる下書きがある日だけ親（page.tsx）が
   * 渡す。dayEventsPanel と同じ理由で盤面プレビューの**直上**（左 sticky カラム内）／フォールバックでは編集
   * セクションの上へ置く。カードを出す日は親が seed 注記と dayEventsPanel を吸収して渡さない（露出を 1 箇所へ）。
   */
  morningDraftCard?: React.ReactNode;
  /**
   * このクラスの実機サイネージ URL（tv_devices.signage_url）。盤面プレビュー直下の副次リンク
   * 「実機の画面を開く」に使う（主導線はアプリ内の実寸プレビュー `/app/editor/[classId]/preview`・#1257）。
   * 未設置クラスは undefined＝副次リンクを出さない（死リンク防止・ゾーン3の同リンクと同じ規律）。
   */
  liveSignageUrl?: string;
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

  // フォームの「今この瞬間」の状態を共有 ref（EditorDraftSyncContext）へ push する。会話 AI（EditorChat）が
  // 会話開始時に下書きの基底として読む（P1: ロード後の手入力を AI が知らず反映で消す穴の是正）。ref 更新のみ
  //（再レンダー非伝播）。Provider 外（テスト等）は null で no-op。プレビュー集約 state と同一値＝盤面に
  // 見えているものがそのまま基底になる（WYSIWYG の原則と一致）。
  const syncRef = useEditorDraftSyncRef();
  useEffect(() => {
    if (syncRef) {
      syncRef.current = { schedules, notices, assignments };
    }
  }, [syncRef, schedules, notices, assignments]);

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
  // スマホ（≤899px）の盤面開閉。既定は畳み（縦積みフォームが主役）。≥900px ではトグル自体が CSS で消え、
  // canvas は常時表示なのでこの state は効かない（開閉はスマホ幅のみの概念）。
  const [mobileBoardOpen, setMobileBoardOpen] = useState(false);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    // スマホで畳み中（display:none）は clientWidth=0 のまま描かれるが不可視なので無害。開いた瞬間に
    // ResizeObserver が実幅で再計測して正しい縮小率になる（既存機構がそのまま働く・jsdom テストも 0 で描画）。
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

  // 全幅日付バー（.dayBar）の実測高さを CSS var `--day-bar-h` に渡し、盤面（.previewCol）の sticky top をバー高さ
  // ぶん下げてバーと重ならないようにする（≥1240px の 2 カラム時に CSS 側で使用）。バー高さは日付タブ1行＋「編集中」＋
  // seed 注記で可変なので magic number でなく ResizeObserver で追従する（計測前の初期値は CSS の fallback 4.5rem）。
  const dayBarRef = useRef<HTMLDivElement>(null);
  const [dayBarHeight, setDayBarHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = dayBarRef.current;
    if (!el) {
      return;
    }
    const measure = () => setDayBarHeight(el.offsetHeight);
    measure();
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

  // 逆連動（スクロール→盤面ハイライト・2026-07-05 user 要望 #3）: 右の編集をスクロールすると、いま画面上部の
  // 「フォーカス帯」に来ている編集セクションに対応する盤面領域を自動でハイライトする（固定した盤面が「今どこを
  // 編集中か」の地図になる＝#1 の固定と噛み合う）。盤面が無い（!showBoard）or IntersectionObserver 非対応
  // （jsdom テスト）では何もしない。クリックジャンプ / フォーカスの setActive とは last-writer で協調（どちらも
  // 「今いる場所」を指すので概ね一致）。編集セクションは pattern で決まり本コンポーネントは date で再マウントする
  // ので、対象の収集は mount 後 1 回で足りる（来校者/呼び出しの anchor も同じ描画で DOM にあるため mount 時に拾える）。
  useEffect(() => {
    if (!showBoard || typeof IntersectionObserver === "undefined") {
      return;
    }
    const targets: Array<{ region: Region; el: HTMLElement }> = [];
    const push = (region: Region, el: HTMLElement | null) => {
      if (el) {
        targets.push({ region, el });
      }
    };
    push("schedules", scheduleRef.current);
    push("notices", noticeRef.current);
    push("assignments", assignmentRef.current);
    if (typeof document !== "undefined") {
      push("visitors", document.getElementById(editorRegionAnchorId("visitors")));
      push("callouts", document.getElementById(editorRegionAnchorId("callouts")));
    }
    if (targets.length === 0) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        // フォーカス帯（rootMargin で上 18%〜下 72% を除外＝画面上部の細い帯）に交差している中で最も上の
        // セクションを active にする。帯に何も無ければ据え置き（highlight をちらつかせない）。
        const inBand = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const topEl = inBand[0]?.target;
        const hit = topEl ? targets.find((t) => t.el === topEl) : undefined;
        if (hit) {
          setActive(hit.region);
        }
      },
      { rootMargin: "-18% 0px -72% 0px", threshold: 0 },
    );
    for (const t of targets) {
      io.observe(t.el);
    }
    return () => io.disconnect();
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
  // 他日入力の活性 pinned（previewPinnedNotices）は draft の前に連結され、実 TV の窓マージ結果と一致する（MEDIUM-2）。
  const previewPayload = useMemo(
    () =>
      base
        ? buildEditorPreviewPayload(
            base,
            { schedules, notices, assignments },
            previewPinnedNotices ?? [],
            previewCarryover,
          )
        : null,
    [base, schedules, notices, assignments, previewPinnedNotices, previewCarryover],
  );
  // 盤面プレビューでも実機と同じく広告を**ローテーション表示**する（要望 2026-06-23: エディタ画面でも広告が
  // 回るように）。回転 index の算出は実機（SignageClient）と同じ共有フック {@link useAdRotation} に寄せる。
  // 広告 0/1 件なら 0 のまま回らない・base 未取得（previewPayload=null）時は空配列で no-op。
  const adIndex = useAdRotation(previewPayload?.ads ?? EMPTY_ADS);

  // このクラスの実機が出すパターンに含まれる**編集対象ブロックだけ**を、**盤面と同じ並び順**で出す
  // （`PATTERN_BLOCKS` 単一ソース＝`editableBlocksForPattern` の配列順。§6.1「見たまま一致」。pattern1 は
  // 予定→連絡→提出物、pattern4 は連絡のみ、pattern5 は**お知らせ（主役・先頭）→今日の予定**）。パターンに
  // 無いブロックは配列に出ないので編集欄も自動で消える（死セクション防止・finding① の対称ケース）。
  // 来校者 / 生徒呼び出しは pattern2/3 用で親（page.tsx）が盤面下に出し分ける（下の map では描かない）。
  // 盤面取得不能（base=null）は既定 pattern1 に倒し従来の縦積みフォーム（予定/連絡/提出物）を出す。
  const pattern = base?.designPattern ?? DEFAULT_SIGNAGE_DESIGN_PATTERN;
  const editorBlocks = editableBlocksForPattern(pattern);
  // このクラスの実機が出すパターンの**規定枠ぶん**、各エディタに空行を事前生成させる（盤面に出る行数を入力前から
  // 提示する・2026-06-23 ユーザー要望）。値は単一ソース {@link blockRowCapacity}。空行は保存・自動保存判定から
  // 除外されるので埋めなくても保存をブロックしない（各エディタの isBlank*Row）。
  const schedulePrefill = blockRowCapacity(pattern, "schedule");
  const noticePrefill = blockRowCapacity(pattern, "notice");
  const assignmentPrefill = blockRowCapacity(pattern, "assignment");

  // 配置最適化（2026-07-05・user-observed「スクロールしないと分からない/盤面が流れて消える」）: 盤面プレビューが
  // ある通常時は 2 カラム（左=盤面 sticky／右=編集）にする（CSS `.layout` が ≥1240px で 2 カラム化・それ未満は
  // 縦積み）。プレビューが無い（base=null / showBoard=false）ときは `.layout` を付けず素の縦積みへフォールバック。
  const hasPreview = Boolean(showBoard && previewPayload);
  return (
    // --day-bar-h: 全幅日付バーの実測高さ。盤面（.previewCol）の sticky top をこのぶん下げてバーと重ならないように
    // する（CSS 側 ≥1240px の calc で使用）。計測前は undefined＝CSS の fallback（4.5rem）が効く。
    <div
      className={styles.root}
      style={
        dayBarHeight != null
          ? ({ "--day-bar-h": `${dayBarHeight}px` } as React.CSSProperties)
          : undefined
      }
    >
      {/* 日付タブ+「編集中」は 2 カラムの上の**全幅 sticky バー**として出す（≥1240px）。狭い左カラム（~500px）に
          入れると日付タブ 5 個（~572px）が 2 行に折り返す（user 2026-07-05）ため、全幅（~1076px）で 1 行にする。バーも
          sticky なのでスクロールで消えず、ちらつき（#1）も維持する。盤面はこのバーの下に sticky（.previewCol の top で
          バー高さぶん下げる）。説明文は引き算済（見れば分かる・クリック→ジャンプは盤面各領域の編集ボタン aria-label が
          担う）。フォールバック（base=null）でもこのバーは常に出る＝日付タブは常時見える。 */}
      <div ref={dayBarRef} className={styles.dayBar}>
        {dayHeader}
      </div>
      {/* フォールバック（盤面プレビュー無し）でも計画操作を失わない: 編集セクションの上に全幅で出す。
          プレビューあり時は previewCol（盤面直下）が担うのでここには出さない（二重表示防止）。 */}
      {/* 朝ドラフトカード（§3.1）: フォールバック（盤面プレビュー無し）では編集セクションの直上に全幅で置く。
          カードを出す日は親が dayEventsPanel を吸収して渡さない（二重露出防止）。 */}
      {!hasPreview ? morningDraftCard : null}
      {!hasPreview && planActions ? <div className={styles.planRow}>{planActions}</div> : null}
      {/* フォールバックでも「この日の行事」を失わない（planActions と同じ規律・行事 0 件は親が渡さない）。 */}
      {!hasPreview ? dayEventsPanel : null}
      <div className={hasPreview ? styles.layout : undefined}>
        {/* 生条件（showBoard && previewPayload）で分岐＝この中で previewPayload が非 null に絞り込まれる
            （hasPreview 定数だと TS が絞り込めず ScaledSignageBoard の payload が null 可能になる）。 */}
        {showBoard && previewPayload ? (
          <div className={styles.previewCol}>
            {/* 朝ドラフトカード（§3.1）: 盤面プレビューの**直上**に置く（合成できる下書きがある日だけ親が渡す）。
                sticky な盤面の上で「開いた瞬間に下書きができている→1 クリック確定」を最短導線にする。 */}
            {morningDraftCard}
            {/* 上段: 実機と同一レイアウトのライブプレビュー（≤899px では非表示）。クリック対象は盤面の**実セクション
              そのもの**（Approach A）。`editRegions` を渡すと `SignageBoardView` が予定 / 連絡 / 提出物の実 `<section>` を
              `position:relative` 化して `inset:0` の編集ボタンを内側に敷く＝実描画要素を覆うので％近似のズレが原理的に
              起きない（旧・別レイヤーの％オーバーレイを廃止）。盤面内部の装飾見出し / region 名は編集モードで AT から
              外れ、操作名は編集ボタンの aria-label が担うので、編集器側の見出し・既存 e2e の strict locator と二重化
              しない。盤面のテキストは下の編集器に等価で出るのでスクリーンリーダ利用者が情報を失わない。 */}
            {/* スマホ専用の盤面開閉トグル（≥900px は CSS で非表示・盤面常時表示）。旧来の「≤899px は完全
                非表示」をやめ、編集結果をその場で確認できるようにする（2026-07-06 スマホ改善）。 */}
            <button
              type="button"
              className={styles.boardToggle}
              aria-expanded={mobileBoardOpen}
              onClick={() => setMobileBoardOpen((v) => !v)}
            >
              {mobileBoardOpen ? "盤面を閉じる" : "盤面を確認"}
            </button>
            <div
              ref={canvasRef}
              className={`${styles.canvas} ${mobileBoardOpen ? styles.canvasOpen : ""}`}
            >
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
            {/* 盤面→実寸確認の直結導線（#1257）: 主導線はアプリ内の実寸プレビュー（スマホでも 16:9 実寸比・
                任意日ナビ可・編集中の日付を引き継ぐ）。実機の生 URL はスマホで縦積みに崩れるため副次リンクへ
                降格して残す（未設置クラスは出さない＝死リンク防止）。どちらも編集を失わないよう別タブ。 */}
            <div className={styles.liveLinkRow}>
              <Link
                className={styles.liveLink}
                href={editorPreviewPath(classId, date)}
                target="_blank"
                rel="noopener noreferrer"
              >
                実寸プレビューを開く ↗
              </Link>
              {liveSignageUrl ? (
                <a
                  className={styles.subLink}
                  href={liveSignageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  実機の画面を開く ↗
                </a>
              ) : null}
            </div>
            {/* 計画系の即応操作（前日/前週コピー・基本時間割）。sticky な盤面の直下＝スクロールゼロで届く。 */}
            {planActions ? <div className={styles.planRow}>{planActions}</div> : null}
            {/* 「この日の行事」（ADR-049 決定 7）。盤面を見ながらワンクリック確定できる位置（盤面直下）。 */}
            {dayEventsPanel}
          </div>
        ) : null}

        {/* 編集セクション（右カラム）: 既存の各セクションエディタ（保存・検証・自動保存・RLS/監査はここが温存
            して担う）。**並び順は PATTERN_BLOCKS の配列順に自動追従**（盤面レイアウトの主役順と「見たまま一致」・
            §6.1。pattern5 は お知らせ が先頭）。見出しはパターン別ラベル（blockLabel §6.2）＝盤面 region 名・
            ジャンプチップと単一ソースで一致（pattern1〜4 は従来の順・従来値のまま非破壊）。 */}
        <div className={styles.editorCol}>
          <div className={styles.editors}>
            {editorBlocks.map((kind) => {
              if (kind === "schedule") {
                return (
                  <EditorCard
                    key={kind}
                    title={blockLabel(pattern, "schedule")}
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
                      // 掲示板型（pattern5）は時限 select でなく時刻テキスト入力（内部は CustomPeriod・保存形不変 §6.2）。
                      slotInput={scheduleInputVariant(pattern)}
                    />
                  </EditorCard>
                );
              }
              if (kind === "notice") {
                return (
                  <EditorCard
                    key={kind}
                    title={blockLabel(pattern, "notice")}
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
                      // 「ずっと（固定表示）」はクラスエディタ限定（HIGH-1）: 削除導線（下の PinnedNoticesList）と
                      // 必ず同居するここでだけ選択可能にする（scope/ops エディタは NoticeEditor 既定 false）。
                      // pattern5（掲示板型）でも同じ経路で生きる＝校訓の受け皿（PR-C × PR-D の合流点）。
                      allowPinned
                    />
                    {/* 固定中のお知らせ（F-C §5.4）: 対象日以外の日に入力された pinned 行は上のエディタに出てこない
                    （幽霊化）ため、連絡カード内に入力日つき一覧と削除導線を出す（受入基準 PR-C-2）。 */}
                    {pinnedNotices && pinnedNotices.length > 0 ? (
                      <PinnedNoticesList
                        classId={classId}
                        currentDate={date}
                        rows={pinnedNotices}
                      />
                    ) : null}
                  </EditorCard>
                );
              }
              if (kind === "assignment") {
                return (
                  <EditorCard
                    key={kind}
                    title={blockLabel(pattern, "assignment")}
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
                );
              }
              // visitor / callout は本コンポーネントが編集カラム内に VisitorsCalloutsSection として出す（下記）。
              return null;
            })}
          </div>
          {/* 来校者 / 生徒呼び出し（pattern2/3 のブロック）。編集カラムに同居させ、盤面プレビュー（左・sticky）を
              見失わずに編集できる。実体（表示・保存・検証・RLS/監査・複製ガード）は VisitorsCalloutsSection が温存。
              親カラム（editorCol＝container）の実幅で 呼び出し｜来校者 の 2/1 カラムを切替（狭い右カラムは 1 カラム）。 */}
          <VisitorsCalloutsSection
            classId={classId}
            date={date}
            pattern={pattern}
            showVisitors={showVisitors}
            showCallouts={showCallouts}
            visitors={visitors}
            callouts={callouts}
          />
        </div>
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
