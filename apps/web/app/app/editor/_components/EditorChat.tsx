"use client";

import {
  applyChatFrame,
  beginUserTurn,
  chatErrorMessage,
  type ChatState,
  finalizeInterruptedTurn,
  finalizeUnterminatedTurn,
  initialChatState,
  isRetryableError,
  parseSseFrames,
  rebaseDraftBeforeFirstTurn,
} from "@/lib/editor/assistant-chat-client";
import { MicIcon } from "@/app/_components/action-icons";
import { useEditorDraftSyncRef } from "./EditorDraftSyncContext";
import {
  type AssistantChatRequestBody,
  type AssistantDayDraft,
  type AssistantDraft,
  DRAFT_SECTION_KINDS,
  type DraftSectionKind,
  EMPTY_DRAFT,
  multiDayWrites,
  preservePinnedNotices,
  stripPinnedFromDraft,
} from "@/lib/editor/assistant-chat-core";
import { assistDraftAllFromFileAction } from "@/lib/editor/assistant-actions";
import {
  type DraftSectionItem,
  assistantGreeting,
  draftItemMeta,
} from "@/lib/editor/assistant-sections";
import { setAssignmentsAction, setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import type { PinnedNoticeRow } from "@/lib/editor/notice-assignment-core";
import {
  type AssignmentDeadlineFormat,
  DEFAULT_ASSIGNMENT_DEADLINE_FORMAT,
} from "@/lib/signage/assignment-deadline-format";
import {
  DEFAULT_SIGNAGE_DESIGN_PATTERN,
  type SignageDesignPattern,
} from "@/lib/signage/design-pattern";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import { formatSignageItem } from "@/lib/signage/section-format";
import { sttErrorHint } from "@/lib/teacher-input/stt-error-hint";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { tokens } from "@kimiterrace/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import styles from "./EditorChat.module.css";

const { color, radius, fontSize } = tokens;

/**
 * 会話型 AI アシスタント UI（**全画面チャット**・finding 2b / モック teacher_ai_fullscreen_first）。
 *
 * 「話す/書く → AI が下書き → **会話の中で確認** → 反映」を多ターン会話で行う client。状態遷移と SSE
 * パースは純ロジック {@link "@/lib/editor/assistant-chat-client"} に委譲（テスト済）。本体は描画と I/O。
 * バックエンドは `POST /api/editor/assistant/chat`。route 未着地時は送信が error に倒れる（入力・下書き保持）。
 *
 * - **反映（保存）は per-section Server Action**（setScheduleAction / setNoticesAction /
 *   setAssignmentsAction）。API は下書きのみ。
 * - **下書きの確認は会話インライン**（ユーザー要望 2026-06-15）。右ペイン常設をやめ、AI が下書きを
 *   まとめ終えたら（status==="done"）会話内に確認カード（反映する / 直す）を出す。会話と並行に動かさない
 *   ことで「会話しながら別所を確認する」負荷を無くす。「直す」or 反映成功でカードを閉じ、次の送信で再表示。
 * - レイアウトは全画面（{@link file://./EditorChat.module.css} `.chat` = ビューポート高・会話は内部
 *   スクロール・入力欄は最下部に常時表示 = LINE 風）。
 */
// 歓迎文は固定文言でなく実効パターンから合成する（assistantGreeting・v2-ed47-5 の根治 §6.4）。
// pattern 未指定（scope エディタ等・3 セクション編集）は pattern1 相当＝従来文言と同値（回帰なし）。

// 入力欄の自動伸長の上限（px）。これを超えたら内部スクロール（~5〜6 行）。CSS の inputStyle.maxHeight と同値。
const INPUT_MAX_HEIGHT = 140;

/** 反映対象セクション集合（meta 由来の許可セクション・未受信時は全セクションに倒す＝追加挙動の保険）。 */
function allowedSetOf(allowedSections: readonly DraftSectionKind[]): ReadonlySet<DraftSectionKind> {
  return allowedSections.length > 0 ? new Set(allowedSections) : new Set(DRAFT_SECTION_KINDS);
}

/**
 * 反映でこのセクションを per-section 置換保存するか（= 盤面が変わりうるか）。下書きは盤面でシードした
 * **完全な目標状態**なので、許可セクションのうち「今 items を持つ（追加 / 編集）」か「盤面に items があった
 * （= 空にする＝**削除**）」ときだけ書く（両方空は触らない＝無駄な空置換・監査ノイズ回避）。確認カードの
 * 表示判定（{@link EditorChat} の showConfirm）と反映（onApply）が必ず一致するよう単一の述語に集約する。
 */
function willWriteSection(
  kind: DraftSectionKind,
  draft: AssistantDraft,
  board: AssistantDraft,
  allowed: ReadonlySet<DraftSectionKind>,
  additiveOnly = false,
): boolean {
  // additiveOnly: 当日の「空配列=削除」を抑止し、items を持つ（追加/編集）ときだけ書く。複数日まとめ（days）が
  // あるターンで使う＝『来週の予定を入れて』のような未来日指示で、当日 top-level が空になっても**今日の盤面を
  // 消さない**（データロス防止・安全側）。単一日（days 無し）では従来どおり削除も検出する（既存挙動は不変）。
  if (additiveOnly) {
    return allowed.has(kind) && draft[kind].length > 0;
  }
  return allowed.has(kind) && (draft[kind].length > 0 || board[kind].length > 0);
}

export function EditorChat({
  scope,
  targetId,
  date,
  initialDraft,
  pinnedNotices,
  pattern = DEFAULT_SIGNAGE_DESIGN_PATTERN,
  assignmentDeadlineFormat = DEFAULT_ASSIGNMENT_DEADLINE_FORMAT,
  variant = "page",
  onApplied,
  injectedMessage,
  onInjectedMessageConsumed,
}: {
  scope: string;
  targetId: string;
  date: string;
  initialDraft?: AssistantDraft;
  /**
   * クラス直の固定行（pinned・入力日つき・getClassPinnedNoticeRows の結果。クラスエディタのみ渡す）。
   * AI 反映は per-date の**置換保存**なので、そのままだと保存先日付の pinned 行（「ずっと」）が無警告で
   * 消える/1 日表示に劣化する（2026-07-04 Reviewer MEDIUM-3）。前日/前週コピー（copyableNoticeItems）と
   * 対称に **AI が置換できるのは非 pinned 行のみ**とし、下書きシードから pinned を除いたうえで
   * （{@link stripPinnedFromDraft}）、反映時に保存先日付の pinned 行を {@link preservePinnedNotices} で
   * 前置き合流させて保全する（当日 top-level・複数日 days の両方）。未指定（scope エディタ等）は保全なし
   * （scope の保存経路は setNoticesAction 側が pinned を剥がす＝HIGH-1 の二層目）。
   */
  pinnedNotices?: PinnedNoticeRow[];
  /**
   * クラスの実効サイネージパターン（歓迎文の合成用 §6.4）。class エディタ（page.tsx）は解決済みの実効
   * パターンを渡す。scope エディタ（学校/学科/学年＝3 セクション編集）は未指定＝pattern1 相当で従来文言。
   * **下書きの許可セクション自体はサーバ（chat route）が別途解決**するので、この prop は表示文言のみに使う
   * （クライアントを信用しない構図は不変）。
   */
  pattern?: SignageDesignPattern;
  /**
   * 提出物の期日表示形式（学校別設定・#1258）。下書き確認カードの 1 行プレビュー（`formatSignageItem`）を
   * 実機盤面の表記（`（〆M/D）` / `（M/Dまで）`）と一致させるために使う。未指定は既定 `daysLeft`（従来表記）。
   */
  assignmentDeadlineFormat?: AssignmentDeadlineFormat;
  /**
   * レイアウト形態。`"page"`（既定）は従来どおりビューポート高を占める全画面チャット。`"floating"` は
   * {@link "../[classId]/_components/FloatingAiChat"} の浮遊パネル内に収まるよう、親（パネル本体）の高さを
   * 100% で満たす（dvh ベースの高さ計算・負 margin を打ち消す）。**会話・保存・SSE の挙動は変えず、外枠の
   * 高さの取り方だけを切り替える**（パネルが内部スクロールを担うため）。
   */
  variant?: "page" | "floating";
  /**
   * 反映（onApply）が**全件成功**した直後に呼ぶ通知（任意）。クラスエディタは
   * {@link "../[classId]/_components/ClassEditorChat"} がこれで `?applied=<nonce>` 再ナビゲートを注入し、
   * フォーム側（WysiwygBoardEditor 配下）を反映後データで再マウントする（2026-07-06 P1: 反映後もフォームが
   * 古いままで、次の自動保存が AI 反映分を上書き消去する実証バグの是正）。未指定（scope エディタ・テスト）は
   * 何もしない（従来挙動）。
   */
  onApplied?: () => void;
  /**
   * P1 写真取込（設計 D5）: 外部（ゾーン1 導線）で OCR 済みの user ターン本文。非 null になったら通常の
   * 送信経路（PII soft-gate / マスク / days 振り分け含む）で自動送信する。クラスエディタのみ
   * {@link "../[classId]/_components/ClassEditorChat"} が photo-import-context から注入する（scope
   * エディタ・テストは未指定＝従来挙動）。
   */
  injectedMessage?: string | null;
  /** 注入ターンの送信に着手した直後に呼ぶ（親が pending を破棄する。二重送信防止）。 */
  onInjectedMessageConsumed?: () => void;
}) {
  // 入力欄の操作ヒント（Enter=送信 / Shift+Enter=改行）を aria-describedby で textarea に紐付けるための安定 id。
  // title だけだと SR/タッチ/キーボード利用者に確実に露出しないため、常時表示の控えめなヒント行も併設する（uo8 補完）。
  const hintId = useId();
  // AI の会話・下書き・差分基準（board）は **pinned 行を除いた**盤面でシードする（MEDIUM-3）。AI は
  // 非 pinned 行だけを見て・置換し、pinned 行は反映時に preservePinnedNotices が保存先日付へ合流させる
  // （モデルが pinned をエコーする保証に依存しない）。
  const [state, setState] = useState<ChatState>(() =>
    initialChatState(stripPinnedFromDraft(initialDraft)),
  );
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // 会話インラインの確認カードを閉じたか（「直す」or 反映成功で閉じ、次の送信/取込で再表示）。
  const [confirmHidden, setConfirmHidden] = useState(false);
  // 「直す」押下直後の誘導ヒント（2026-07-06 監査 P2-3: カードが黙って消えるだけで次の一手が無い）。
  // 表示専用（messages には積まない）。次の送信 / ファイル取込で消す。
  const [fixHint, setFixHint] = useState(false);
  // 盤面の現状スナップショット（= 反映の差分判定の基準）。初期はサーバ由来の initialDraft（盤面の現状・
  // pinned 除外＝下書きと同じ土俵で比較する）で、反映成功でこのセッションが盤面を上書きするたび反映後の
  // 下書きへ更新する。「下書きは空だが盤面には項目があった」= 削除指示、を判定して(1)空セクションの置換保存
  // =全消去を起こし(2)空盤面への純粋な聞き返しでは確認カードを出さない、を成立させる（編集/削除対応・追加
  // 挙動は不変）。pinned 行は比較対象外＝AI 経由では削除も検出されず消えない（保全は反映時のマージが担う）。
  const [board, setBoard] = useState<AssistantDraft>(
    () => stripPinnedFromDraft(initialDraft) ?? EMPTY_DRAFT,
  );
  const streamingRef = useRef(false);
  // 進行中の SSE を中断するための AbortController（停止ボタン）。null=非ストリーミング。
  const abortRef = useRef<AbortController | null>(null);
  // 会話の最下部アンカー。新着メッセージ/ストリーム/下書きで最下部へ自動スクロールする（チャットの基本挙動）。
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 日本語 IME 変換中フラグ。変換確定の Enter で誤送信しないためのガード（compositionstart/end で開閉）。
  const composingRef = useRef(false);
  const [fileBusy, setFileBusy] = useState(false);
  const stt = useSpeechToText();
  // フォームの「今この瞬間」の状態への共有 ref（EditorDraftSyncContext）。会話開始時に下書きの基底を
  // これで再シードする（P1: ロード後の手入力を AI が知らず反映で消す穴の是正）。Provider 外は null。
  const syncRef = useEditorDraftSyncRef();

  /**
   * 入力欄を内容に応じて自動で縦に伸ばす（LINE 風）。`height=auto` で一旦縮めてから `scrollHeight` を測り、
   * `INPUT_MAX_HEIGHT` で頭打ちにする（超過分は内部スクロール）。CSS の `maxHeight` と同値で揃える。見た目の
   * 調整専用で、会話・保存・SSE の挙動には一切触れない。
   */
  const autoGrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, []);

  // 入力テキストが変わるたび高さを再計算（送信後リセット・音声入力の流し込みにも追従）。
  // input は再計算のトリガ（autoGrow は inputRef 経由で現在値を読むため body には現れない）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: input は高さ再計算のトリガ（送信後リセット/STT 流し込みに追従）
  useEffect(() => {
    autoGrow();
  }, [autoGrow, input]);

  // 音声入力: 端末内 STT の確定テキストを入力欄へ流し込む（サーバには文字だけが乗る・プライバシー）。
  useEffect(() => {
    if (stt.transcript) {
      setInput((prev) => (prev ? `${prev} ${stt.transcript}` : stt.transcript));
      stt.reset();
    }
  }, [stt.transcript, stt.reset]);

  /** base（messages 確定済）に対し 1 ターン分の SSE を流して状態を更新する。 */
  const stream = useCallback(
    async (base: ChatState, ackPii: boolean) => {
      let working: ChatState = { ...base, status: "streaming", error: null, streamingText: "" };
      setState(working);
      const body: AssistantChatRequestBody = {
        messages: working.messages,
        draft: working.draft,
        acknowledgePii: ackPii,
      };
      // 停止ボタンで中断できるよう AbortController を張る（中断はユーザー操作＝エラー扱いしない）。
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(
          `/api/editor/assistant/chat?scope=${encodeURIComponent(scope)}&targetId=${encodeURIComponent(targetId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        if (!res.ok || !res.body) {
          // SSE を開く前の JSON エラー（401/403/400/503）。下書き・入力は保持。
          setState((s) => ({
            ...s,
            status: "error",
            error: {
              reason: res.status === 503 ? "stream_failed" : "invalid",
              message: res.status === 503 ? "AI 機能が現在無効です。" : undefined,
            },
          }));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseFrames(buffer);
          buffer = parsed.rest;
          for (const f of parsed.frames) {
            working = applyChatFrame(working, f);
          }
          setState(working);
        }
        // 終端フレーム（done/error）を受け取らないままストリームが閉じたら、永久に「考えています」で固まらない
        // よう再試行可能な失敗に畳む（Cloud Run リクエストタイムアウト・プロキシ切断・モデル無応答後のクローズ）。
        working = finalizeUnterminatedTurn(working);
        setState(working);
      } catch {
        // ユーザーが停止: 途中までの応答・下書きを残しエラーにしない。それ以外は通信/モデル障害。
        if (controller.signal.aborted) {
          setState(finalizeInterruptedTurn(working));
        } else {
          setState((s) => ({ ...s, status: "error", error: { reason: "stream_failed" } }));
        }
      } finally {
        streamingRef.current = false;
        abortRef.current = null;
        // 注入ターン（P1 写真取込）の待ち合わせ保証: streamingRef は ref で再描画を起こさないため、
        // ストリーミング中に注入が到着したケースは「終了後の state 変化」で effect を再評価させる必要が
        // ある。ところが正常終了パスでは done フレーム処理後の finalize が同一参照を返し setState が
        // ベイルアウトしうる（Reviewer MEDIUM: done と close が別イベントで届くと pending が滞留）。
        // ref を下ろした後に必ず 1 回 state の参照を更新して再評価を保証する（内容は不変・浅い複製のみ）。
        setState((s) => ({ ...s }));
      }
    },
    [scope, targetId],
  );

  /**
   * 送信本体（入力欄からの {@link onSend} と写真取込の注入ターンが共有）: user ターンを積んで stream。
   * 新しいターンなので前の確認カードは再表示可に戻す。呼び出し側で streamingRef を立ててから呼ぶこと。
   */
  const sendContent = useCallback(
    (content: string) => {
      setSaveMsg(null);
      setConfirmHidden(false);
      setFixHint(false);
      // 会話開始（最初の送信）なら、下書きの基底をフォームの現在値へ再シードする（P1 是正）。initialDraft は
      // ページロード時のスナップショットで、ロード後の手入力（自動保存済み）を含まない＝そのまま基底にすると
      // AI の「完全な目標状態」から手入力が抜け、反映（置換保存）が手入力を消す。pinned はシードと同じ土俵で
      // 剥がす（stripPinnedFromDraft・反映時に preservePinnedNotices が合流）。差分基準（board）も同時に揃える。
      const current = syncRef?.current
        ? stripPinnedFromDraft({
            schedules: [...syncRef.current.schedules],
            notices: [...syncRef.current.notices],
            assignments: [...syncRef.current.assignments],
          })
        : undefined;
      const rebased = rebaseDraftBeforeFirstTurn(state, current ?? null);
      if (rebased !== state) {
        setBoard(rebased.draft);
      }
      const base = beginUserTurn(rebased, content);
      void stream(base, false);
    },
    [state, stream, syncRef],
  );

  /** 新規送信（入力欄）。 */
  const onSend = useCallback(() => {
    const content = input.trim();
    if (streamingRef.current || !content) return;
    streamingRef.current = true;
    setInput("");
    sendContent(content);
  }, [input, sendContent]);

  // P1 写真取込（D5）: 親（ClassEditorChat）から注入された OCR 済みターンを、通常の user ターンとして
  // 自動送信する。送信ガード（streamingRef/fileBusy）を先に取り、consume（pending 破棄）してから送る
  // （StrictMode の効果二重実行では 2 回目が streamingRef で弾かれ、二重送信・二重 consume にならない）。
  useEffect(() => {
    if (!injectedMessage) return;
    if (streamingRef.current || fileBusy) return;
    streamingRef.current = true;
    onInjectedMessageConsumed?.();
    sendContent(injectedMessage);
    // ストリーミング終了時の再評価は sendContent の依存（state）変化で起きる（streamingRef 自体は
    // ref で再描画を起こさないが、stream 完了は必ず state 更新を伴う）。
  }, [injectedMessage, fileBusy, onInjectedMessageConsumed, sendContent]);

  /** PII 警告の「承知して送信」: 直近の messages をそのまま acknowledgePii=true で再送（user ターンは積まない）。 */
  const onAcknowledge = useCallback(() => {
    if (streamingRef.current) return;
    streamingRef.current = true;
    void stream(state, true);
  }, [state, stream]);

  /** 生成の停止: 進行中の SSE を中断する（中断後の状態確定は stream の catch が finalizeInterruptedTurn で行う）。 */
  const onStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 再試行: 一時的失敗（通信/混雑）後に、直近のターンをそのまま再送する（user ターンは既に積まれている）。 */
  const onRetry = useCallback(() => {
    if (streamingRef.current) return;
    streamingRef.current = true;
    setSaveMsg(null);
    void stream(state, false);
  }, [state, stream]);

  // 新着メッセージ/ストリーム/下書き/状態変化のたびに会話の最下部へスクロールする（チャットの基本挙動）。
  // scrollIntoView は jsdom 等で未実装のため `?.()` でガードする（テスト環境で throw させない）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: スクロールのトリガ群（内容変化を見て最下部へ寄せる）
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [state.messages.length, state.streamingText, state.status]);

  /**
   * 反映: 下書きを既存 per-section Server Action で盤面へ保存する（API は下書きのみ）。成功で確認カードを閉じる。
   *
   * 下書きは（盤面でシードされた）**完全な目標状態**なので、per-section の「置換」保存で盤面を下書きに一致させる。
   * 書くのはこのクラスの許可セクション（meta 由来・未受信時は全セクションに倒す）のうち、
   *  - 今 items を持つ（追加 / 編集）か
   *  - 盤面に items があった（= 空にする = **削除**対象がある）
   * セクションのみ（両方空のセクションは触らない＝無駄な空置換・監査ノイズ回避）。空配列の保存は当該セクションの
   * 全消去になる（daily-data-write は値をそのまま置換）。これで編集・削除が成立する（旧実装は空セクションを
   * 常にスキップし、削除が盤面に反映されなかった）。
   */
  const onApply = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveMsg(null);
    const d = state.draft;
    const allowed = allowedSetOf(state.allowedSections);
    const days = multiDayWrites(
      d,
      state.allowedSections.length > 0 ? state.allowedSections : DRAFT_SECTION_KINDS,
    );
    // 複数日まとめがあるターンでは当日 top-level を追加専用にする（当日の盤面を空配列で消さない・上記述語参照）。
    const additiveCurrentDay = days.length > 0;
    try {
      // 当日 1 日分（top-level）: 編集/削除（盤面との差分）対応の従来経路。days 同梱時は追加専用（削除抑止）。
      // 連絡の置換保存は保存先日付の pinned 行を前置き合流させて保全する（preservePinnedNotices・MEDIUM-3。
      // AI が置換できるのは非 pinned 行のみ＝「連絡を全部削除して」でも pinned 行は残る）。
      // 当日 top-level がどのセクションを書くか（days ループの当日重複ガードにも使う）。
      const topLevelWrites = {
        schedules: willWriteSection("schedules", d, board, allowed, additiveCurrentDay),
        notices: willWriteSection("notices", d, board, allowed, additiveCurrentDay),
        assignments: willWriteSection("assignments", d, board, allowed, additiveCurrentDay),
      };
      const ops: (ReturnType<typeof setScheduleAction> | null)[] = [
        topLevelWrites.schedules ? setScheduleAction(scope, targetId, date, d.schedules) : null,
        topLevelWrites.notices
          ? setNoticesAction(
              scope,
              targetId,
              date,
              preservePinnedNotices(pinnedNotices, date, d.notices),
            )
          : null,
        topLevelWrites.assignments
          ? setAssignmentsAction(scope, targetId, date, d.assignments)
          : null,
      ];
      // 複数日まとめ（days）: 各日の **非空セクションのみ**を、その日付へ置換保存する。未来日には盤面スナップ
      // ショットが無いため削除検出は行わない（追加的）。許可セクション絞りは multiDayWrites 済み（meta 由来）。
      // 連絡は各日付の pinned 行も保全する（その日付に入力済みの固定行を置換で消さない）。
      for (const day of days) {
        // 当日（基準日）と同じ日付の days エントリは、top-level が既に書くセクションを二重に書かない。
        // 同じ (クラス, 日付, セクション) 行への並行 replace-save は last-writer-wins になり、AI が
        // 仕様違反で当日を top-level と days の両方に出したとき盤面が部分的に化ける。top-level が書か
        // ないセクション（＝仕様どおり top-level 空で当日を days に入れた複数日ターン）はそのまま days
        // が書くのでデータ欠落しない。当日以外の days エントリは従来どおり無条件で書く。
        const isCurrentDate = day.date === date;
        if (day.schedules.length > 0 && !(isCurrentDate && topLevelWrites.schedules)) {
          ops.push(setScheduleAction(scope, targetId, day.date, day.schedules));
        }
        if (day.notices.length > 0 && !(isCurrentDate && topLevelWrites.notices)) {
          ops.push(
            setNoticesAction(
              scope,
              targetId,
              day.date,
              preservePinnedNotices(pinnedNotices, day.date, day.notices),
            ),
          );
        }
        if (day.assignments.length > 0 && !(isCurrentDate && topLevelWrites.assignments)) {
          ops.push(setAssignmentsAction(scope, targetId, day.date, day.assignments));
        }
      }
      const results = await Promise.all(ops);
      const failed = results.some((r) => r !== null && !r.ok);
      setSaveMsg(
        failed ? "一部の反映に失敗しました。もう一度お試しください。" : "盤面に反映しました。",
      );
      if (!failed) {
        // 当日の盤面が当日下書きに一致した。次の差分判定（削除検出 / 確認カード表示）の基準を更新する
        //（基準は当日 top-level のみ・days は未来日で当日盤面に無関係）。連絡は保存された**非 pinned 部**
        //（pinned フラグの demote 後）を基準にする＝シードと同じ pinned 除外の土俵を維持する。
        setBoard({
          schedules: d.schedules,
          notices: preservePinnedNotices(undefined, date, d.notices),
          assignments: d.assignments,
        });
        setConfirmHidden(true);
        // 全件成功したときだけ親へ通知する（クラスエディタはこれで ?applied= 再ナビ→フォーム再マウント。
        // 一部失敗時は再マウントしない＝どのセクションが古いか不定のまま「反映済みに見える」誤認を避け、
        // ユーザーに再試行してもらう）。
        onApplied?.();
      }
    } catch {
      setSaveMsg("反映に失敗しました。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    state.draft,
    state.allowedSections,
    board,
    scope,
    targetId,
    date,
    pinnedNotices,
    onApplied,
  ]);

  /** ファイル取り込み: PDF/Word/Excel/画像を既存 action で全セクション下書きに（非ストリーミング・保存しない）。 */
  const onFile = useCallback(
    async (file: File) => {
      if (streamingRef.current || fileBusy) return;
      setFileBusy(true);
      setSaveMsg(null);
      setConfirmHidden(false);
      setFixHint(false);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await assistDraftAllFromFileAction(scope, targetId, fd, {});
        if (r.ok) {
          setState((s) => ({
            ...s,
            status: "done",
            error: null,
            draft: { schedules: r.schedules, notices: r.notices, assignments: r.assignments },
          }));
        } else {
          setState((s) => ({
            ...s,
            status: "error",
            error: { reason: "no_result", message: "ファイルから読み取れませんでした。" },
          }));
        }
      } catch {
        setState((s) => ({
          ...s,
          status: "error",
          error: { reason: "stream_failed", message: "ファイルの取り込みに失敗しました。" },
        }));
      } finally {
        setFileBusy(false);
      }
    },
    [fileBusy, scope, targetId],
  );

  const streaming = state.status === "streaming";
  const pii = state.error?.reason === "pii_warning" ? state.error : null;
  const otherError = state.error && state.error.reason !== "pii_warning" ? state.error : null;
  // 音声入力の「実際の失敗」（権限拒否・マイク無し・非対応 等）だけを拾ってヒントを出す。
  // 良性コード（no-speech / aborted）や未発生は null（誤警告回避）。出し分けは純関数に集約（テスト済）。
  const micHint = sttErrorHint(stt.error);
  // pattern2 等で連絡/提出物が許可外のとき、来校者/呼び出しは手入力へ誘導する（ADR-034）。
  const restrictedToSchedules =
    state.allowedSections.length > 0 &&
    !state.allowedSections.includes("notices") &&
    !state.allowedSections.includes("assignments");
  // 複数日まとめ（days）の反映単位（許可セクション絞り済・空日は除外）。当日 top-level とは別に各日付へ書く。
  const dayWrites = multiDayWrites(
    state.draft,
    state.allowedSections.length > 0 ? state.allowedSections : DRAFT_SECTION_KINDS,
  );
  // 反映で盤面が変わりうるセクション（追加 / 編集 = 下書きに items、削除 = 盤面に items があり下書きは空）。
  // onApply と同じ述語で導く（カード表示と実反映が必ず一致する）。days 同梱時は当日を追加専用にし、未来日
  // 指示で当日の削除予告（clearedSections）が誤って出ないようにする（onApply の additiveCurrentDay と一致）。
  const pendingWrites = DRAFT_SECTION_KINDS.filter((k) =>
    willWriteSection(
      k,
      state.draft,
      board,
      allowedSetOf(state.allowedSections),
      dayWrites.length > 0,
    ),
  );
  // 会話インラインの確認カード: AI が下書きをまとめ終え（done）・未確定（閉じてない）で、反映で盤面が変わる
  // ものがあるとき。下書きも盤面も空（＝空盤面への純粋な聞き返し）では出さない。これで「全部削除」も確認
  // カードから反映できる（旧実装は下書きが空だとカードが出ず、削除を反映する手段が無かった）。複数日下書き
  // （days）があるときも確認カードを出す（当日 top-level が空でも複数日分を反映できるように）。
  const showConfirm =
    state.status === "done" && !confirmHidden && (pendingWrites.length > 0 || dayWrites.length > 0);
  // そのうち**全消去**になるセクション（書くが下書きは空＝削除）。削除時は下書きカードに並べる項目が無いので、
  // 何が消えるかを明示して空カードに見えないようにする。
  const clearedSections = pendingWrites.filter((k) => state.draft[k].length === 0);
  // 編集対象日の表示ラベル（例「7/15（水）」）。挨拶と確認カード / 反映ボタンで反映先日付を明示する
  //（2026-07-06 監査 P2-1/2: 16 時カットオーバー後は対象日が翌授業日で「今日」が嘘になる・反映先が出ない）。
  const dayLabel = formatDayLabel(date);

  return (
    <section
      aria-label="AIアシスタント"
      className={variant === "floating" ? `${styles.chat} ${styles.floating}` : styles.chat}
    >
      <div className={styles.thread}>
        <Bubble from="assistant">{assistantGreeting(pattern, dayLabel)}</Bubble>
        {state.messages.map((m, i) => (
          // 会話は追記のみで並び替えしないため index key で十分。
          // biome-ignore lint/suspicious/noArrayIndexKey: 追記専用の会話ログ
          <Bubble key={i} from={m.role}>
            {m.content}
          </Bubble>
        ))}
        {streaming && state.streamingText ? (
          <Bubble from="assistant">{state.streamingText}</Bubble>
        ) : null}
        {streaming && !state.streamingText ? <p style={hintStyle}>AI が考えています…</p> : null}

        {/* 下書きの確認は会話の中で（並行表示しない）。AI が「この内容で反映してよいか」を尋ね、押すと反映。 */}
        {showConfirm ? (
          <div className={styles.itemIn} style={confirmCardStyle}>
            {/* 反映先日付を冒頭で明示する（P2-2: 日付の取り違え防止）。複数日下書き（days）は日付ごとに
                反映するため単一日付を掲げず、従来の「N日分」表記（daysHeadStyle の見出し）に委ねる。 */}
            <div style={{ fontSize: fontSize.sm, marginBottom: "0.5rem" }}>
              {dayWrites.length > 0 ? (
                <>
                  下書きにまとめました。
                  <span style={{ fontWeight: 700 }}>この内容で反映してよいですか？</span>
                </>
              ) : (
                <>
                  <span style={{ fontWeight: 700 }}>{dayLabel}の盤面</span>
                  に反映します。この内容でよいですか？
                </>
              )}
            </div>
            <DraftSection title="予定" kind="schedules" items={state.draft.schedules} />
            <DraftSection title="連絡" kind="notices" items={state.draft.notices} />
            <DraftSection
              title="提出物"
              kind="assignments"
              items={state.draft.assignments}
              deadlineFormat={assignmentDeadlineFormat}
            />
            {dayWrites.length > 0 ? (
              <div style={{ marginTop: "0.35rem" }}>
                <p style={daysHeadStyle}>
                  {dayWrites.length}日分の下書きです（日付ごとに反映します）。
                </p>
                {dayWrites.map((day) => (
                  <DayDraftSummary
                    key={day.date}
                    day={day}
                    deadlineFormat={assignmentDeadlineFormat}
                  />
                ))}
              </div>
            ) : null}
            {clearedSections.length ? (
              <p style={clearNoteStyle}>
                {clearedSections.map((k) => SECTION_LABEL_JA[k]).join("・")}をすべて削除します。
              </p>
            ) : null}
            <div style={confirmActionsStyle}>
              <button
                type="button"
                className={`${styles.btn} ${styles.apply}`}
                onClick={onApply}
                disabled={saving}
              >
                {/* 複数日（days）は日付ごとに反映するため単一日付を付けない（付けると嘘になる）。 */}
                {saving ? "反映中…" : dayWrites.length > 0 ? "反映する" : `${dayLabel}に反映`}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.ghost}`}
                onClick={() => {
                  setConfirmHidden(true);
                  setFixHint(true);
                }}
                disabled={saving}
              >
                直す
              </button>
            </div>
          </div>
        ) : null}

        {/* 「直す」直後の誘導（P2-3: カードが黙って消えるだけで次の一手が無い）。表示専用の淡い 1 行で、
            会話ログ（messages）には積まない。次の送信 / ファイル取込で消える。 */}
        {fixHint && !showConfirm ? (
          <p style={hintStyle}>どこを直しますか？（例:「数学は3限に」「体育を消して」）</p>
        ) : null}

        {saveMsg ? <p style={savedNoteStyle}>{saveMsg}</p> : null}

        {restrictedToSchedules ? (
          <p style={hintStyle}>
            来校者・呼び出しは AI
            では追加できません。下の「盤面を編集」から手入力で追加してください。
          </p>
        ) : null}

        {pii ? (
          <div style={warnBoxStyle}>
            <p style={{ margin: "0 0 0.4rem", fontWeight: 600, color: color.warningFg }}>
              氏名らしき語が含まれています
              {pii.suspectedSurfaces?.length ? `（${pii.suspectedSurfaces.join("・")}）` : ""}。
            </p>
            <p style={{ margin: "0 0 0.6rem", fontSize: fontSize.sm, color: color.ink }}>
              個人名はサイネージ・AI に残らないようご注意ください。承知のうえ送信しますか？
            </p>
            <button type="button" style={warnBtnStyle} onClick={onAcknowledge} disabled={streaming}>
              承知して送信
            </button>
          </div>
        ) : null}

        {otherError ? (
          <div style={errorBoxStyle}>
            <p style={errorTextStyle}>
              {otherError.message ?? chatErrorMessage(otherError.reason)}
            </p>
            {isRetryableError(otherError.reason) ? (
              <button
                type="button"
                style={retryBtnStyle}
                onClick={onRetry}
                disabled={streaming || fileBusy}
              >
                再試行
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 会話の最下部アンカー（自動スクロール先）。 */}
        <div ref={bottomRef} />
      </div>

      <div className={styles.composer}>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.csv,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className={`${styles.btn} ${styles.iconBtn}`}
          onClick={() => fileRef.current?.click()}
          disabled={streaming || fileBusy}
          title="ファイルから取り込む（PDF / Word / Excel / 画像）"
          aria-label="ファイルから取り込む"
        >
          ＋
        </button>
        <textarea
          ref={inputRef}
          style={inputStyle}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          // IME 変換中は誤送信を避けるためフラグを立て、Enter 送信判定で見る。
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            // Enter=送信 / Shift+Enter=改行（LINE 風）。IME 変換確定の Enter（composing 中・nativeEvent.isComposing・
            // keyCode 229）では送信しない。⌘/Ctrl+Enter も従来どおり送信を維持。
            if (e.key !== "Enter") {
              return;
            }
            const composing =
              composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229;
            if (composing) {
              return;
            }
            if (e.shiftKey) {
              return; // 改行を許可
            }
            e.preventDefault();
            onSend();
          }}
          placeholder="話す・書く・ファイルで…"
          // 操作ヒント（Enter=送信 / Shift+Enter=改行）は placeholder に詰め込むと狭幅パネルで不自然に折返す
          //（LEDGER v2-ed-uo8）。placeholder は短くし、ヒントは下部の常時表示行（hintId）＋ title（ツールチップ）に逃がす。
          // title はマウス利用者向けの補助で、SR/キーボード/タッチには aria-describedby（hintId の行）が露出を担保する。
          title="Enter で送信 / Shift+Enter で改行"
          aria-describedby={hintId}
          rows={1}
          disabled={streaming}
        />
        {stt.supported ? (
          <button
            type="button"
            className={`${styles.btn} ${stt.listening ? styles.micActive : styles.mic}`}
            onClick={() => {
              if (streaming) return;
              if (stt.listening) stt.stop();
              else stt.start();
            }}
            aria-label={stt.listening ? "音声入力を止める" : "音声入力"}
            aria-pressed={stt.listening}
            title="音声入力"
          >
            <MicIcon />
          </button>
        ) : null}
        {streaming ? (
          // 生成中は「送信」を「停止」に差し替え、進行中の応答を中断できるようにする。
          <button
            type="button"
            className={`${styles.btn} ${styles.send}`}
            onClick={onStop}
            aria-label="生成を停止"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.send}`}
            onClick={onSend}
            disabled={fileBusy || !input.trim()}
            aria-label="送信"
          >
            {fileBusy ? "読込中…" : "送信"}
          </button>
        )}
      </div>

      {/* 入力欄の操作ヒント。常時表示の控えめな1行（uo8 補完）。aria-describedby で textarea に紐付き、
          SR/キーボード/タッチでも Shift+Enter 改行を発見できる。装飾色は使わず muted トークンのみ。 */}
      <p id={hintId} style={inputHintStyle}>
        Enter で送信 / Shift+Enter で改行
      </p>

      {/* 音声入力が実際に失敗したときだけ、マイク直下に短いヒントを出す（role=status で読み上げ）。 */}
      {micHint ? (
        <p role="status" style={micHintStyle}>
          {micHint}
        </p>
      ) : null}
    </section>
  );
}

/** セクション種別 → 確認カードの和名（削除予告文言用）。DraftSection の title と表記を揃える。 */
const SECTION_LABEL_JA: Record<DraftSectionKind, string> = {
  schedules: "予定",
  notices: "連絡",
  assignments: "提出物",
};

function Bubble({ from, children }: { from: "user" | "assistant"; children: React.ReactNode }) {
  const isUser = from === "user";
  return (
    <div style={isUser ? userBubbleStyle : assistantBubbleStyle}>
      <span>{children}</span>
    </div>
  );
}

/** YYYY-MM-DD → 「6/29（月）」表示。複数日カードの日付見出し（表示専用・不正値はそのまま返す）。 */
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
function formatDayLabel(date: string): string {
  const dt = new Date(`${date}T00:00:00`);
  if (Number.isNaN(dt.getTime())) {
    return date;
  }
  return `${dt.getMonth() + 1}/${dt.getDate()}（${WEEKDAY_JA[dt.getDay()]}）`;
}

/** 複数日まとめ（days）の 1 日分サマリ。日付見出し + その日の予定/連絡/提出物（空セクションは出さない）。 */
function DayDraftSummary({
  day,
  deadlineFormat,
}: {
  day: AssistantDayDraft;
  deadlineFormat: AssignmentDeadlineFormat;
}) {
  return (
    <div style={dayCardStyle}>
      <div style={dayLabelStyle}>{formatDayLabel(day.date)}</div>
      <DraftSection title="予定" kind="schedules" items={day.schedules} />
      <DraftSection title="連絡" kind="notices" items={day.notices} />
      <DraftSection
        title="提出物"
        kind="assignments"
        items={day.assignments}
        deadlineFormat={deadlineFormat}
      />
    </div>
  );
}

function DraftSection<K extends DraftSectionKind>({
  title,
  kind,
  items,
  deadlineFormat = DEFAULT_ASSIGNMENT_DEADLINE_FORMAT,
}: {
  title: string;
  kind: K;
  items: readonly DraftSectionItem[K][];
  /** 提出物（kind='assignments'）のみ影響する期日表示形式（#1258）。他セクションは無視される。 */
  deadlineFormat?: AssignmentDeadlineFormat;
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div style={{ padding: "0.3rem 0", borderTop: `1px solid ${color.border}` }}>
      <div style={{ fontSize: fontSize.xs, color: color.muted }}>{title}</div>
      <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.1rem", display: "grid", gap: "0.15rem" }}>
        {items.map((item, i) => {
          const line = formatSignageItem(kind, item, deadlineFormat);
          // 反映前に確認できるよう、本文に出ない詳細（場所/対象者/表示日数/固定/★）を小さく併記する
          //（P2-4・draftItemMeta）。区切り線行は併記なし（validate が詳細フィールドを剥がす）。
          const meta = line.divider ? null : draftItemMeta(kind, item);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 静的下書きの描画
            <li key={i} style={{ fontSize: fontSize.sm }}>
              {/* 区切り線（PR-B §5.3）は下書き一覧でも「── ラベル ──」として可視化（空テキスト行にしない）。 */}
              {line.divider ? `── ${line.text || "区切り線"} ──` : line.text}
              {meta ? <span style={draftMetaStyle}> {meta}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const userBubbleStyle: React.CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "88%",
  background: color.infoBg,
  borderRadius: "14px",
  borderTopRightRadius: "4px",
  padding: "0.5rem 0.7rem",
  fontSize: "1rem",
  lineHeight: 1.6,
  color: color.ink,
};
const assistantBubbleStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "88%",
  background: "#fff",
  border: `1px solid ${color.border}`,
  borderRadius: "14px",
  borderTopLeftRadius: "4px",
  padding: "0.5rem 0.7rem",
  fontSize: "1rem",
  lineHeight: 1.6,
  color: color.ink,
};
const hintStyle: React.CSSProperties = { margin: 0, fontSize: fontSize.sm, color: color.muted };
const savedNoteStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  margin: 0,
  fontSize: fontSize.sm,
  color: color.ink,
};
// エラー表示（文言 + 一時的失敗なら「再試行」）。danger 配色のボックスに縦並び。
const errorBoxStyle: React.CSSProperties = {
  alignSelf: "stretch",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  alignItems: "flex-start",
  color: color.dangerFg,
  background: color.dangerBg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.md,
  padding: "0.5rem 0.7rem",
};
const errorTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.dangerFg,
};
const retryBtnStyle: React.CSSProperties = {
  minHeight: "36px",
  padding: "0.3rem 0.9rem",
  background: color.primary,
  color: "#fff",
  border: "none",
  borderRadius: radius.md,
  fontSize: "0.9rem",
  fontWeight: 600,
  cursor: "pointer",
};
// 会話インラインの確認カード（assistant 寄せ・下書き要約 + 反映/直す）。
const confirmCardStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "92%",
  background: "#fff",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  padding: "0.7rem 0.85rem",
};
const confirmActionsStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  marginTop: "0.7rem",
};
// 複数日まとめ（days）の見出しと 1 日カード（確認カード内に日付ごとに並べる）。
const daysHeadStyle: React.CSSProperties = {
  margin: "0.3rem 0 0.1rem",
  fontSize: fontSize.sm,
  fontWeight: 700,
  color: color.ink,
};
const dayCardStyle: React.CSSProperties = {
  marginTop: "0.35rem",
  padding: "0.25rem 0.5rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.infoBg,
};
const dayLabelStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 700,
  color: color.ink,
};
// 下書き行の詳細併記（場所/対象者/表示日数/固定/★・P2-4）。本文より一段小さい muted（トークンのみ）。
const draftMetaStyle: React.CSSProperties = {
  fontSize: fontSize.xs,
  color: color.muted,
};
// 削除予告（盤面の項目を全消去するときの注意文）。danger 配色で確認カード内に出す。
const clearNoteStyle: React.CSSProperties = {
  margin: "0.3rem 0 0",
  paddingTop: "0.3rem",
  borderTop: `1px solid ${color.border}`,
  fontSize: fontSize.sm,
  fontWeight: 600,
  color: color.dangerFg,
};
const warnBoxStyle: React.CSSProperties = {
  alignSelf: "stretch",
  background: color.warningBg,
  border: `1px solid ${color.warningBorder}`,
  borderRadius: radius.md,
  padding: "0.7rem 0.85rem",
};
const warnBtnStyle: React.CSSProperties = {
  minHeight: "40px",
  padding: "0.4rem 1rem",
  background: color.primary,
  color: "#fff",
  border: "none",
  borderRadius: radius.md,
  fontSize: "0.95rem",
  fontWeight: 600,
  cursor: "pointer",
};
const micHintStyle: React.CSSProperties = {
  margin: 0,
  padding: "0 0.7rem 0.6rem",
  fontSize: fontSize.sm,
  color: color.dangerFg,
};
// 入力欄の操作ヒント（常時表示・控えめ）。最小サイズの muted テキスト。トークンのみ・生 hex/px を使わない。
const inputHintStyle: React.CSSProperties = {
  margin: 0,
  padding: "0 0.7rem 0.6rem",
  fontSize: fontSize.xs,
  color: color.muted,
};
// 入力欄: 内容に応じて高さを自動調整（autoGrow が height を JS 制御）し、上限で内部スクロール。
// 高さは JS が握るので手動ドラッグ resize は無効化（JS と取り合いになるのを避ける）。min/max は保険。
const inputStyle: React.CSSProperties = {
  flex: 1,
  minHeight: "44px",
  maxHeight: `${INPUT_MAX_HEIGHT}px`,
  padding: "0.6rem 0.8rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  fontSize: "1rem",
  lineHeight: 1.5,
  resize: "none",
  overflowY: "auto",
  fontFamily: "inherit",
};
