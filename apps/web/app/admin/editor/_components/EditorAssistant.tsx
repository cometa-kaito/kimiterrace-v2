"use client";

import { assistDraftNoticesFromFileAction } from "@/lib/editor/assistant-actions";
import type { AssistDraftResult, NoticeTone } from "@/lib/editor/assistant-core";
import { setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import type { AssignmentItem, NoticeItem } from "@/lib/editor/notice-assignment-core";
import { streamNoticeDraft } from "@/lib/editor/notice-draft-client";
import type { ScheduleItem } from "@/lib/editor/schedule-core";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  ASSIGNMENT_DRAFT_CONFIG,
  SCHEDULE_DRAFT_CONFIG,
  SectionDraftPanel,
} from "./SectionDraftPanel";
import styles from "./editor-assistant.module.css";

/** 採用前にその場で編集できるドラフトカード（採用するまで保存に触れない＝可逆プレビュー, ADR-033）。 */
type DraftCard = {
  /** 安定キー。 */
  id: string;
  /** 連絡本文（採用前にその場で編集可）。 */
  text: string;
  /** 重要マーク。 */
  isHighlight: boolean;
  /** 反映対象に含めるか（既定 true。Notion/Docs 流の項目ごと採否）。 */
  accepted: boolean;
};

/** ファイル入力で受理する MIME（PDF / Word / Excel。画像 OCR は未配線ゆえ非対応）。 */
const FILE_ACCEPT = [
  ".pdf",
  ".docx",
  ".xlsx",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
].join(",");

/** トーン/長さ調整チップ（主・副）。key は NoticeTone、label は UI 文言（設計 §2.4・日本語の敬語を一級扱い）。 */
const PRIMARY_TONES: { key: NoticeTone; label: string }[] = [
  { key: "short", label: "短く" },
  { key: "detailed", label: "くわしく" },
  { key: "polite", label: "ていねいに" },
  { key: "soft", label: "やわらかく" },
];
const SECONDARY_TONES: { key: NoticeTone; label: string }[] = [
  { key: "concise", label: "簡潔に" },
  { key: "formal", label: "かしこまった表現に" },
  { key: "rephrase", label: "言い換え" },
  { key: "bullet", label: "箇条書き的に" },
  { key: "plain", label: "やさしい日本語" },
];

/**
 * 段C+（#243 ②UI-UX, ADR-033）: エディタ AI アシスタントの **ストリーミング再設計**。
 *
 * 旧 UI（「作成中…」スピナー → チェックボックスのフラットなリスト → 全件一括 apply）を、Notion AI /
 * Google Docs「Help me write」/ ChatGPT に学んだ **「項目ごとに確定ストリーミング → 採用/削除/編集 →
 * 反映」** へ作り替える（設計 docs/design/ai-editor-assist-ux.md）。
 *
 * - **テキスト経路**: `streamNoticeDraft`（SSE）で連絡を **1 件ずつカードに反映**（送信直後に作成中表示、
 *   完成項目から個別に採否）。**停止** で中断しても既に届いたカードは保持する。
 * - **ファイル経路（PDF/Word/Excel）**: 現状は既存 Server Action（非ストリーミング）の結果を同じカード UI に
 *   流し込む（ストリーミング化は後続スライス）。
 * - **採用前に編集可・可逆プレビュー**: 採用するまで保存（`setNoticesAction`）に触れない。1 件の不採用が
 *   他の良い項目を壊さない（全件一括 apply の廃止）。
 * - **PII soft-gate（ADR-030）**: 氏名らしき語を検出したら警告し、「承知して続ける」で override 再実行。
 *   個人情報を含む可能性で除外された項目（`notice_redacted`）は件数を表示する。
 *
 * トーン調整 / 項目ごと作り直し / ファイルのストリーミング化 / キーボード操作は後続スライス（PR-4/5）。
 */
export function EditorAssistant({
  scope,
  targetId,
  date,
  existingNotices,
  existingSchedules = [],
  existingAssignments = [],
}: {
  scope: string;
  targetId: string;
  date: string;
  existingNotices: NoticeItem[];
  existingSchedules?: ScheduleItem[];
  existingAssignments?: AssignmentItem[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // 作成する種類（タブ）。連絡=ストリーミング（本体）、予定/提出物=非ストリーミング（SectionDraftPanel）。
  const [mode, setMode] = useState<"notices" | "schedules" | "assignments">("notices");
  const [text, setText] = useState("");
  const [instruction, setInstruction] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [cards, setCards] = useState<DraftCard[]>([]);
  const [redactedCount, setRedactedCount] = useState(0);
  const [warnSurfaces, setWarnSurfaces] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const speech = useSpeechToText("ja-JP");

  function nextId(): string {
    idRef.current += 1;
    return `c${idRef.current}`;
  }

  function toggleMic() {
    if (speech.listening) {
      speech.stop();
      const captured = `${speech.transcript} ${speech.interim}`.trim();
      if (captured) {
        setText((prev) => (prev ? `${prev} ${captured}` : captured));
      }
      speech.reset();
    } else {
      speech.reset();
      speech.start();
    }
  }

  function clearFile() {
    setPendingFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  /** 新規生成の開始時に提案・警告・件数表示をリセットする（入力テキストは残す）。 */
  function resetProposal() {
    setMsg(null);
    setWarnSurfaces(null);
    setRedactedCount(0);
    setCards([]);
  }

  /** AssistDraftResult（ファイル経路・非ストリーミング）をカード UI に流し込む。 */
  function applyResultToCards(res: AssistDraftResult) {
    if (res.ok) {
      setCards(
        res.notices.map((n) => ({
          id: nextId(),
          text: n.text,
          isHighlight: n.isHighlight === true,
          accepted: true,
        })),
      );
    } else if (res.reason === "pii_warning") {
      setWarnSurfaces(res.suspectedSurfaces);
    } else {
      setMsg(message(res.reason));
    }
  }

  /**
   * テキスト経路: SSE で 1 件ずつカードに反映する（停止可・エラー時も入力/既送出カードを保持）。
   * `opts.tone`（プリセット）/ `opts.instruction`（自由指示）を渡すと同じメモを調整して再生成する。
   */
  async function runTextStream(
    acknowledgePii: boolean,
    opts: { tone?: NoticeTone; instruction?: string } = {},
  ) {
    const memo = text.trim();
    if (memo.length === 0) {
      setMsg(message("empty"));
      return;
    }
    resetProposal();
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for await (const ev of streamNoticeDraft({
        scope,
        targetId,
        text: memo,
        acknowledgePii,
        tone: opts.tone,
        instruction: opts.instruction,
        signal: controller.signal,
      })) {
        if (ev.type === "notice") {
          setCards((prev) => [
            ...prev,
            { id: nextId(), text: ev.text, isHighlight: ev.isHighlight, accepted: true },
          ]);
        } else if (ev.type === "notice_redacted") {
          setRedactedCount((n) => n + 1);
        } else if (ev.type === "error") {
          if (ev.reason === "pii_warning") {
            setWarnSurfaces(ev.suspectedSurfaces ?? []);
          } else {
            setMsg(message(ev.reason));
          }
        }
        // done: ループ終了で確定（下記 finally）。
      }
    } catch {
      // abort（停止）は AbortError で来るが、既送出カードは保持し、エラー文言は出さない。
      if (!controller.signal.aborted) {
        setMsg(message("network"));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  /** ファイル経路: 既存 Server Action（非ストリーミング）→ カード UI。 */
  async function runFile(acknowledgePii: boolean, file: File) {
    resetProposal();
    setStreaming(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await assistDraftNoticesFromFileAction(scope, targetId, fd, { acknowledgePii });
      applyResultToCards(res);
    } catch {
      setMsg("ファイルを送信できませんでした（上限 10MB を超えている可能性があります）。");
    } finally {
      setStreaming(false);
    }
  }

  /** 「承知して続ける」: 直前の入力経路（ファイル優先、無ければテキスト）を override で再実行。 */
  function acknowledgeAndRetry() {
    if (pendingFile) {
      runFile(true, pendingFile);
    } else {
      runTextStream(true);
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setPendingFile(f);
    if (f) {
      runFile(false, f);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function updateCard(id: string, patch: Partial<DraftCard>) {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function removeCard(id: string) {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }
  function setAllAccepted(v: boolean) {
    setCards((prev) => prev.map((c) => ({ ...c, accepted: v })));
  }

  async function apply() {
    const picked = cards.filter((c) => c.accepted && c.text.trim().length > 0);
    if (picked.length === 0) {
      setMsg("反映する連絡を1つ以上選んでください。");
      return;
    }
    setSaving(true);
    const items: NoticeItem[] = picked.map((c) =>
      c.isHighlight ? { text: c.text.trim(), isHighlight: true } : { text: c.text.trim() },
    );
    const merged = [...existingNotices, ...items];
    const res = await setNoticesAction(scope, targetId, date, merged);
    setSaving(false);
    if (res.ok) {
      setMsg(`連絡に反映しました（${items.length}件）。`);
      setCards([]);
      setText("");
      setRedactedCount(0);
      clearFile();
      router.refresh();
    } else {
      setMsg(res.error.message);
    }
  }

  const acceptedCount = cards.filter((c) => c.accepted).length;
  const canGenerate = !streaming && text.trim().length > 0;

  return (
    <>
      <button
        type="button"
        className={styles.fab}
        aria-expanded={open}
        aria-label="AIアシスタントを開く"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" className={styles.fabFace}>
          🤖
        </span>
        AI
      </button>

      {open ? (
        <div className={styles.panel} role="dialog" aria-label="AI アシスタント">
          <div className={styles.header}>
            <strong>AI アシスタント</strong>
            <button type="button" className={styles.ghost} onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>

          {/* 作成する種類のタブ（連絡 / 予定 / 提出物）。既定は連絡（既存ストリーミング UI）。 */}
          <div
            role="tablist"
            aria-label="作成する種類"
            style={{ display: "flex", gap: "0.25rem", margin: "0 0 0.5rem" }}
          >
            {(
              [
                ["notices", "連絡"],
                ["schedules", "予定"],
                ["assignments", "提出物"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={styles.ghost}
                style={
                  mode === m
                    ? { fontWeight: 700, borderBottom: "2px solid #2563eb", color: "#1d4ed8" }
                    : undefined
                }
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "schedules" ? (
            <SectionDraftPanel
              scope={scope}
              targetId={targetId}
              date={date}
              existing={existingSchedules}
              config={SCHEDULE_DRAFT_CONFIG}
            />
          ) : mode === "assignments" ? (
            <SectionDraftPanel
              scope={scope}
              targetId={targetId}
              date={date}
              existing={existingAssignments}
              config={ASSIGNMENT_DRAFT_CONFIG}
            />
          ) : (
            <>
              <p className={styles.hint}>
                話す・入力する・ファイル（PDF / Word / Excel）から、AI
                が「連絡」の下書きを作ります。
                完成した順に確認し、採用するものだけ反映してください。
              </p>

              <textarea
                className={styles.textarea}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="例: 明日は短縮授業で午後は部活なし。図書室の返却は金曜まで。"
                rows={3}
                disabled={streaming}
              />

              <div className={styles.row}>
                {speech.supported ? (
                  <button
                    type="button"
                    className={speech.listening ? styles.micOn : styles.ghost}
                    onClick={toggleMic}
                    disabled={streaming}
                  >
                    {speech.listening ? "● 録音中（停止）" : "🎤 音声入力"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={streaming}
                  onClick={() => fileInputRef.current?.click()}
                >
                  📄 ファイルから
                </button>
                {streaming ? (
                  <button type="button" className={styles.ghost} onClick={stop}>
                    ■ 停止
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={!canGenerate}
                    onClick={() => {
                      clearFile();
                      runTextStream(false);
                    }}
                  >
                    AIで連絡を作る
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={FILE_ACCEPT}
                aria-label="ファイルを選択（PDF・Word・Excel）"
                style={{ display: "none" }}
                onChange={onFilePicked}
              />
              {pendingFile ? (
                <p className={styles.interim}>
                  {streaming ? "ファイルを読み取り中… " : "選択中: "}
                  {pendingFile.name}
                </p>
              ) : null}
              {speech.listening ? <p className={styles.interim}>{speech.interim}</p> : null}

              {/* ストリーミング状況（aria-live で逐次読み上げ, NFR05）。 */}
              <div aria-live="polite" className={styles.interim}>
                {streaming ? (
                  <span className={styles.pulse}>
                    ● AI が連絡を作成中…（完成した順に表示されます）
                  </span>
                ) : null}
              </div>

              {warnSurfaces ? (
                <div className={styles.warn}>
                  個人名らしき語が含まれている可能性があります（{warnSurfaces.join("、")}）。
                  掲示に個人名を載せないのが原則です。承知の上で続けますか？
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={streaming}
                      onClick={acknowledgeAndRetry}
                    >
                      承知して続ける
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => setWarnSurfaces(null)}
                    >
                      やめる
                    </button>
                  </div>
                </div>
              ) : null}

              {cards.length > 0 ? (
                <div className={styles.proposal}>
                  <div className={styles.proposalHead}>
                    <strong>AI の下書き</strong>
                    <span className={styles.count}>
                      採用 {acceptedCount} / {cards.length} 件
                    </span>
                  </div>
                  <ul className={styles.list}>
                    {cards.map((c) => (
                      <li
                        key={c.id}
                        className={`${styles.card} ${c.accepted ? "" : styles.cardOff}`}
                      >
                        <textarea
                          className={styles.cardText}
                          value={c.text}
                          rows={2}
                          aria-label="連絡本文（編集できます）"
                          onChange={(e) => updateCard(c.id, { text: e.target.value })}
                        />
                        <div className={styles.cardActions}>
                          <button
                            type="button"
                            className={c.accepted ? styles.acceptOn : styles.ghost}
                            aria-pressed={c.accepted}
                            onClick={() => updateCard(c.id, { accepted: !c.accepted })}
                          >
                            {c.accepted ? "✓ 採用" : "採用する"}
                          </button>
                          <button
                            type="button"
                            className={c.isHighlight ? styles.hiOn : styles.ghost}
                            aria-pressed={c.isHighlight}
                            onClick={() => updateCard(c.id, { isHighlight: !c.isHighlight })}
                          >
                            {c.isHighlight ? "⚠ 重要" : "重要にする"}
                          </button>
                          <button
                            type="button"
                            className={styles.ghost}
                            onClick={() => removeCard(c.id)}
                          >
                            削除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {redactedCount > 0 ? (
                    <p className={styles.interim}>
                      個人情報を含む可能性のある {redactedCount} 件を除外しました。
                    </p>
                  ) : null}
                  {text.trim().length > 0 ? (
                    <div className={styles.toneBar} aria-label="トーン・長さの調整">
                      <span className={styles.toneLabel}>調整して作り直す:</span>
                      {PRIMARY_TONES.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          className={styles.tone}
                          disabled={streaming}
                          onClick={() => runTextStream(false, { tone: t.key })}
                        >
                          {t.label}
                        </button>
                      ))}
                      <details className={styles.toneMore}>
                        <summary className={styles.toneSummary}>他の調整</summary>
                        <div className={styles.toneMoreRow}>
                          {SECONDARY_TONES.map((t) => (
                            <button
                              key={t.key}
                              type="button"
                              className={styles.tone}
                              disabled={streaming}
                              onClick={() => runTextStream(false, { tone: t.key })}
                            >
                              {t.label}
                            </button>
                          ))}
                        </div>
                      </details>
                    </div>
                  ) : null}
                  {text.trim().length > 0 ? (
                    <div className={styles.toneBar} aria-label="加筆・部分修正の指示">
                      <input
                        type="text"
                        className={styles.instructionInput}
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder="例: 部活の連絡も足して / もっとやさしく"
                        maxLength={200}
                        disabled={streaming}
                        aria-label="加筆・修正の指示"
                      />
                      <button
                        type="button"
                        className={styles.tone}
                        disabled={streaming || instruction.trim().length === 0}
                        onClick={() => runTextStream(false, { instruction: instruction.trim() })}
                      >
                        この指示で作り直す
                      </button>
                    </div>
                  ) : null}
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={saving || streaming}
                      onClick={apply}
                    >
                      {saving ? "反映中…" : `連絡に反映する（${acceptedCount}）`}
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      disabled={streaming}
                      onClick={() => setAllAccepted(true)}
                    >
                      すべて採用
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      disabled={streaming}
                      onClick={() => setAllAccepted(false)}
                    >
                      すべて解除
                    </button>
                    {text.trim().length > 0 ? (
                      <button
                        type="button"
                        className={styles.ghost}
                        disabled={streaming}
                        onClick={() => runTextStream(false)}
                      >
                        ↻ 全部作り直す
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.ghost}
                      disabled={streaming || saving}
                      onClick={() => {
                        setCards([]);
                        setRedactedCount(0);
                        clearFile();
                      }}
                    >
                      破棄
                    </button>
                  </div>
                </div>
              ) : null}

              {msg ? (
                <p className={styles.msg} role="status">
                  {msg}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

/** 表示文言（ストリーム error.reason / 旧 action reason の両方を写像）。本文/内部詳細は出さない（ルール4）。 */
const MESSAGES: Record<string, string> = {
  ai_disabled: "AI 機能が現在無効です。",
  disabled: "AI 機能が現在無効です。",
  forbidden: "権限がありません。",
  unauthenticated: "ログインが必要です。再度ログインしてお試しください。",
  invalid_target: "編集対象が不正です。",
  rate_limited: "短時間に使いすぎました。少し待って再度お試しください。",
  pii_leak: "個人情報が含まれる可能性があるため中止しました。",
  empty: "メモを入力するか、ファイルを選んでください。",
  too_long: "入力が長すぎます。短くしてください。",
  too_large: "ファイルが大きすぎます（上限 10MB）。",
  unsupported_format: "対応していない形式です（PDF・Word・Excel のみ。画像は今後対応）。",
  no_text: "ファイルから文字を読み取れませんでした。",
  extract_failed: "ファイルを読み取れませんでした（破損・暗号化の可能性）。",
  no_result: "うまく作成できませんでした。言い換えて再度お試しください。",
  stream_failed: "応答の生成に失敗しました。もう一度お試しください。",
  network: "通信に失敗しました。電波の良い場所でもう一度お試しください。",
  request_failed: "うまくいきませんでした。もう一度お試しください。",
};

/** reason を表示文言に写像する（未知 reason は汎用文言。noUncheckedIndexedAccess 下で必ず string）。 */
function message(reason: string): string {
  return MESSAGES[reason] ?? "うまくいきませんでした。もう一度お試しください。";
}
