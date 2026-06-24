"use client";

import {
  assistDraftAssignmentAction,
  assistDraftAssignmentFromFileAction,
  assistDraftScheduleAction,
  assistDraftScheduleFromFileAction,
} from "@/lib/editor/assistant-actions";
import { setAssignmentsAction } from "@/lib/editor/notice-assignment-actions";
import type { AssignmentItem } from "@/lib/editor/notice-assignment-core";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import type { ActionResult, SchedulePeriod, ScheduleItem } from "@/lib/editor/schedule-core";
import {
  CUSTOM_PERIOD_MAX,
  SCHEDULE_SLOT_OPTIONS,
  isCustomPeriod,
  isSpecialSlot,
} from "@/lib/editor/schedule-core";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import styles from "./editor-assistant.module.css";

/**
 * 予定(schedules) / 提出物(assignments) の **非ストリーミング** AI ドラフトパネル（F02本丸 PR-3）。
 *
 * 連絡(notices)は SSE ストリーミング（{@link EditorAssistant} 本体）だが、予定/提出物は件数が少なく
 * 構造的なので 1 ショットの Server Action（`assistDraftSchedule/AssignmentAction`）で候補を取得し、同じ
 * 「採用前に編集可・可逆プレビュー → 反映」UX（ADR-033）に流し込む。`config` でセクション差分（アクション・
 * 保存・カードの編集フィールド）を注入し、入力(テキスト/音声/ファイル) → soft-gate override → カード編集 →
 * 採用反映の本体は共通化する。マスク/soft-gate/監査は Server Action 側（runSectionDraft）が担う（ルール4）。
 */

/** AI ドラフトの結果を section 非依存に正規化したもの。 */
type DraftOutcome<TItem> =
  | { ok: true; items: TItem[] }
  | { ok: false; reason: string; suspectedSurfaces?: string[] };

/** セクション差分（連絡以外）。アクション・保存・カード編集 UI を注入する。 */
export type SectionDraftConfig<TItem> = {
  /** ヘッダ見出し（例「AI で予定を作る」）。 */
  title: string;
  /** 入力ヒント。 */
  hint: string;
  /** textarea プレースホルダ（音声/メモの例）。 */
  placeholder: string;
  /** 生成ボタン文言（例「AIで予定を作る」）。 */
  generateLabel: string;
  /** 反映ボタン文言の語幹（例「予定」→「予定に反映する」）。 */
  noun: string;
  /** テキスト → 候補（Server Action を section 非依存に正規化）。 */
  draftFromText: (
    scope: string,
    targetId: string,
    text: string,
    opts: { acknowledgePii?: boolean },
  ) => Promise<DraftOutcome<TItem>>;
  /** ファイル → 候補（同上）。 */
  draftFromFile: (
    scope: string,
    targetId: string,
    formData: FormData,
    opts: { acknowledgePii?: boolean },
  ) => Promise<DraftOutcome<TItem>>;
  /** 既存 + 採用分を保存（既存 setScheduleAction / setAssignmentsAction）。検証は action 側が最終強制。 */
  save: (
    scope: string,
    targetId: string,
    date: string,
    items: TItem[],
  ) => Promise<ActionResult<unknown>>;
  /** カード 1 件の編集フィールド（period セレクタ / date ピッカー等）。 */
  renderFields: (item: TItem, set: (patch: Partial<TItem>) => void) => ReactNode;
};

/** 採用前に編集できるドラフトカード（採用するまで保存に触れない＝可逆プレビュー, ADR-033）。 */
type Card<TItem> = { id: string; item: TItem; accepted: boolean };

/** ファイル入力で受理する MIME（PDF / Word / Excel。画像 OCR は未配線ゆえ非対応、連絡と同一）。 */
const FILE_ACCEPT = [
  ".pdf",
  ".docx",
  ".xlsx",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
].join(",");

const MESSAGES: Record<string, string> = {
  disabled: "AI 機能が現在無効です。",
  forbidden: "権限がありません。",
  rate_limited: "短時間に使いすぎました。少し待って再度お試しください。",
  pii_leak: "個人情報が含まれる可能性があるため中止しました。",
  empty: "メモを入力するか、ファイルを選んでください。",
  too_long: "入力が長すぎます。短くしてください。",
  too_large: "ファイルが大きすぎます（上限 10MB）。",
  unsupported_format: "対応していない形式です（PDF・Word・Excel のみ。画像は今後対応）。",
  no_text: "ファイルから文字を読み取れませんでした。",
  extract_failed: "ファイルを読み取れませんでした（破損・暗号化の可能性）。",
  no_result: "うまく作成できませんでした。言い換えて再度お試しください。",
  network: "通信に失敗しました。電波の良い場所でもう一度お試しください。",
};
function message(reason: string): string {
  return MESSAGES[reason] ?? "うまくいきませんでした。もう一度お試しください。";
}

export function SectionDraftPanel<TItem>({
  scope,
  targetId,
  date,
  existing,
  config,
}: {
  scope: string;
  targetId: string;
  date: string;
  existing: TItem[];
  config: SectionDraftConfig<TItem>;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cards, setCards] = useState<Card<TItem>[]>([]);
  const [warnSurfaces, setWarnSurfaces] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const idRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const speech = useSpeechToText("ja-JP");

  function nextId(): string {
    idRef.current += 1;
    return `s${idRef.current}`;
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

  function reset() {
    setMsg(null);
    setWarnSurfaces(null);
    setCards([]);
  }

  function applyOutcome(outcome: DraftOutcome<TItem>) {
    if (outcome.ok) {
      setCards(outcome.items.map((item) => ({ id: nextId(), item, accepted: true })));
    } else if (outcome.reason === "pii_warning") {
      setWarnSurfaces(outcome.suspectedSurfaces ?? []);
    } else {
      setMsg(message(outcome.reason));
    }
  }

  async function runText(acknowledgePii: boolean) {
    const memo = text.trim();
    if (memo.length === 0) {
      setMsg(message("empty"));
      return;
    }
    reset();
    setBusy(true);
    try {
      applyOutcome(await config.draftFromText(scope, targetId, memo, { acknowledgePii }));
    } catch {
      setMsg(message("network"));
    } finally {
      setBusy(false);
    }
  }

  async function runFile(acknowledgePii: boolean, file: File) {
    reset();
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      applyOutcome(await config.draftFromFile(scope, targetId, fd, { acknowledgePii }));
    } catch {
      setMsg("ファイルを送信できませんでした（上限 10MB を超えている可能性があります）。");
    } finally {
      setBusy(false);
    }
  }

  function acknowledgeAndRetry() {
    if (pendingFile) {
      runFile(true, pendingFile);
    } else {
      runText(true);
    }
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setPendingFile(f);
    if (f) {
      runFile(false, f);
    }
  }

  function updateCard(id: string, patch: Partial<TItem>) {
    setCards((prev) =>
      prev.map((c) => (c.id === id ? { ...c, item: { ...c.item, ...patch } } : c)),
    );
  }
  function setAccepted(id: string, accepted: boolean) {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, accepted } : c)));
  }
  function removeCard(id: string) {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }

  async function apply() {
    const picked = cards.filter((c) => c.accepted).map((c) => c.item);
    if (picked.length === 0) {
      setMsg(`反映する${config.noun}を1つ以上選んでください。`);
      return;
    }
    setSaving(true);
    const res = await config.save(scope, targetId, date, [...existing, ...picked]);
    setSaving(false);
    if (res.ok) {
      setMsg(`${config.noun}に反映しました（${picked.length}件）。`);
      setCards([]);
      setText("");
      clearFile();
      router.refresh();
    } else {
      setMsg(res.error.message);
    }
  }

  const acceptedCount = cards.filter((c) => c.accepted).length;
  const canGenerate = !busy && text.trim().length > 0;

  return (
    <>
      <p className={styles.hint}>{config.hint}</p>

      <textarea
        className={styles.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={config.placeholder}
        rows={3}
        disabled={busy}
      />

      <div className={styles.row}>
        {speech.supported ? (
          <button
            type="button"
            className={speech.listening ? styles.micOn : styles.ghost}
            onClick={toggleMic}
            disabled={busy}
          >
            {speech.listening ? "● 録音中（停止）" : "🎤 音声入力"}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.ghost}
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          📄 ファイルから
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={!canGenerate}
          onClick={() => {
            clearFile();
            runText(false);
          }}
        >
          {config.generateLabel}
        </button>
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
          {busy ? "ファイルを読み取り中… " : "選択中: "}
          {pendingFile.name}
        </p>
      ) : null}
      {speech.listening ? <p className={styles.interim}>{speech.interim}</p> : null}

      <div aria-live="polite" className={styles.interim}>
        {busy ? <span className={styles.pulse}>● AI が{config.noun}を作成中…</span> : null}
      </div>

      {warnSurfaces ? (
        <div className={styles.warn}>
          個人名らしき語が含まれている可能性があります（{warnSurfaces.join("、")}）。
          掲示に個人名を載せないのが原則です。承知の上で続けますか？
          <div className={styles.row}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={acknowledgeAndRetry}
            >
              承知して続ける
            </button>
            <button type="button" className={styles.ghost} onClick={() => setWarnSurfaces(null)}>
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
              <li key={c.id} className={`${styles.card} ${c.accepted ? "" : styles.cardOff}`}>
                {config.renderFields(c.item, (patch) => updateCard(c.id, patch))}
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={c.accepted ? styles.acceptOn : styles.ghost}
                    aria-pressed={c.accepted}
                    onClick={() => setAccepted(c.id, !c.accepted)}
                  >
                    {c.accepted ? "✓ 採用" : "採用する"}
                  </button>
                  <button type="button" className={styles.ghost} onClick={() => removeCard(c.id)}>
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className={styles.row}>
            <button
              type="button"
              className={styles.primary}
              disabled={saving || busy}
              onClick={apply}
            >
              {saving ? "反映中…" : `${config.noun}に反映する（${acceptedCount}）`}
            </button>
            <button
              type="button"
              className={styles.ghost}
              disabled={busy || saving}
              onClick={reset}
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
  );
}

/** カード編集フィールド用の小さなラベル付き入力（CSS Module 非依存の最小スタイル）。 */
const fieldWrap: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem 0.6rem",
  alignItems: "center",
};
const fieldLabel: React.CSSProperties = { fontSize: "0.78rem", color: "#6b7280" };
const fieldInput: React.CSSProperties = {
  fontSize: "0.9rem",
  padding: "0.25rem 0.4rem",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};

/** 「その他（自由入力）」を表す select の番兵値（実 period 値ではない・UI 専用）。ScheduleEditor と同方針。 */
const CUSTOM_SLOT_VALUE = "__custom__";

/**
 * `ScheduleItem.period`（省略可）を select の現在値（文字列）へ写す。ScheduleEditor の `slotSelectValue` と同方針だが、
 * ドラフトカードは Row state を介さず `ScheduleItem` を直接編集するため、番兵 0（UNSELECTED_PERIOD）ではなく
 * **`undefined`（時限なし＝科目のみ）を直接** 空文字に倒す。これがないと `String(undefined)` = "undefined" となり
 * どの option にも一致せず select の表示が崩れる（PR #1192 で period が任意化された後の AI 下書きに対応）。
 */
function slotSelectValue(period: SchedulePeriod | undefined): string {
  if (period === undefined) {
    return "";
  }
  if (isCustomPeriod(period)) {
    return CUSTOM_SLOT_VALUE;
  }
  return String(period);
}

/**
 * select の値（文字列）を `ScheduleItem.period` へ戻す。空=時限なし（`undefined`）/「その他」=自由入力（既存テキストを
 * 保持し、無ければ空で開始）/ 特殊スロットはそのまま / それ以外は数値化。ScheduleEditor の `parseSlotValue` と同方針。
 */
function parseSlotValue(
  value: string,
  current: SchedulePeriod | undefined,
): SchedulePeriod | undefined {
  if (value === "") {
    return undefined;
  }
  if (value === CUSTOM_SLOT_VALUE) {
    return isCustomPeriod(current) ? current : { custom: "" };
  }
  return isSpecialSlot(value) ? value : Number(value);
}

/** 予定(schedules) のセクション設定。period セレクタ + 科目/場所/対象者/補足。 */
export const SCHEDULE_DRAFT_CONFIG: SectionDraftConfig<ScheduleItem> = {
  title: "AI で予定を作る",
  hint: "話す・入力する・ファイル（PDF / Word / Excel）から、AI が「予定（時間割）」の下書きを作ります。時限・場所を確認し、採用するものだけ反映してください。",
  placeholder: "例: 1限は数学、2限は体育で体育館、3限は学年集会。",
  generateLabel: "AIで予定を作る",
  noun: "予定",
  draftFromText: async (scope, targetId, text, opts) => {
    const r = await assistDraftScheduleAction(scope, targetId, text, opts);
    return r.ok ? { ok: true, items: r.schedules } : r;
  },
  draftFromFile: async (scope, targetId, formData, opts) => {
    const r = await assistDraftScheduleFromFileAction(scope, targetId, formData, opts);
    return r.ok ? { ok: true, items: r.schedules } : r;
  },
  save: (scope, targetId, date, items) => setScheduleAction(scope, targetId, date, items),
  renderFields: (item, set) => (
    <div style={fieldWrap}>
      <label style={fieldLabel}>
        時限{" "}
        <select
          value={slotSelectValue(item.period)}
          aria-label="時限"
          style={{ ...fieldInput, width: "6rem" }}
          onChange={(e) => set({ period: parseSlotValue(e.target.value, item.period) })}
        >
          {/* 時限なし（科目のみ）。period が任意化された後（PR #1192）の AI 下書きはこれを選べる＝科目だけで盤面表示。 */}
          <option value="">（時限なし）</option>
          {SCHEDULE_SLOT_OPTIONS.map((opt) => (
            <option key={String(opt.value)} value={String(opt.value)}>
              {opt.label}
            </option>
          ))}
          <option value={CUSTOM_SLOT_VALUE}>その他</option>
        </select>
      </label>
      {isCustomPeriod(item.period) ? (
        <label style={fieldLabel}>
          時限（自由入力）{" "}
          <input
            type="text"
            value={item.period.custom}
            onChange={(e) => set({ period: { custom: e.target.value } })}
            placeholder="例: 補習"
            maxLength={CUSTOM_PERIOD_MAX}
            aria-label="時限（自由入力）"
            style={{ ...fieldInput, width: "8rem" }}
          />
        </label>
      ) : null}
      <label style={fieldLabel}>
        科目{" "}
        <input
          type="text"
          value={item.subject}
          aria-label="科目"
          style={fieldInput}
          onChange={(e) => set({ subject: e.target.value })}
        />
      </label>
      <label style={fieldLabel}>
        場所{" "}
        <input
          type="text"
          value={item.location ?? ""}
          aria-label="場所"
          style={fieldInput}
          onChange={(e) => set({ location: e.target.value })}
        />
      </label>
      <label style={fieldLabel}>
        対象者{" "}
        <input
          type="text"
          value={item.targetAudience ?? ""}
          aria-label="対象者"
          style={fieldInput}
          onChange={(e) => set({ targetAudience: e.target.value })}
        />
      </label>
    </div>
  ),
};

/** 提出物(assignments) のセクション設定。締切(date) + 科目/内容。 */
export const ASSIGNMENT_DRAFT_CONFIG: SectionDraftConfig<AssignmentItem> = {
  title: "AI で提出物を作る",
  hint: "話す・入力する・ファイル（PDF / Word / Excel）から、AI が「提出物（課題）」の下書きを作ります。締切（実在する日付）を確認し、採用するものだけ反映してください。",
  placeholder: "例: 数学のワークP30を明日まで、英語の音読カードを金曜まで。",
  generateLabel: "AIで提出物を作る",
  noun: "提出物",
  draftFromText: async (scope, targetId, text, opts) => {
    const r = await assistDraftAssignmentAction(scope, targetId, text, opts);
    return r.ok ? { ok: true, items: r.assignments } : r;
  },
  draftFromFile: async (scope, targetId, formData, opts) => {
    const r = await assistDraftAssignmentFromFileAction(scope, targetId, formData, opts);
    return r.ok ? { ok: true, items: r.assignments } : r;
  },
  save: (scope, targetId, date, items) => setAssignmentsAction(scope, targetId, date, items),
  renderFields: (item, set) => (
    <div style={fieldWrap}>
      <label style={fieldLabel}>
        締切{" "}
        <input
          type="date"
          value={item.deadline}
          aria-label="締切"
          style={fieldInput}
          onChange={(e) => set({ deadline: e.target.value })}
        />
      </label>
      <label style={fieldLabel}>
        科目{" "}
        <input
          type="text"
          value={item.subject}
          aria-label="科目"
          style={fieldInput}
          onChange={(e) => set({ subject: e.target.value })}
        />
      </label>
      <label style={fieldLabel}>
        内容{" "}
        <input
          type="text"
          value={item.task}
          aria-label="内容"
          style={{ ...fieldInput, minWidth: "12rem" }}
          onChange={(e) => set({ task: e.target.value })}
        />
      </label>
    </div>
  ),
};
