"use client";

import { FileIcon, MicIcon } from "@/app/_components/action-icons";
import { assistDraftAllAction, assistDraftAllFromFileAction } from "@/lib/editor/assistant-actions";
import { setAssignmentsAction, setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import type { AssignmentItem, NoticeItem } from "@/lib/editor/notice-assignment-core";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import type { ActionResult, ScheduleItem } from "@/lib/editor/schedule-core";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { useRouter } from "next/navigation";
import { type ReactNode, useRef, useState } from "react";
import { ASSIGNMENT_DRAFT_CONFIG, SCHEDULE_DRAFT_CONFIG } from "./SectionDraftPanel";
import styles from "./editor-assistant.module.css";

/**
 * 「おまかせ」統合パネル（F02本丸 PR-6b / ADR-036）。1 入力（テキスト/音声/ファイル）を AI が
 * 予定/連絡/提出物に**分類**して 3 セクション同時に提案する（`assistDraftAllAction`）。各カードは採用前に
 * その場編集可（可逆プレビュー, ADR-033）。反映は **per-section の保存 action を順に呼ぶ**（ADR-036:
 * 非原子・冪等 upsert・部分失敗は巻き戻さず明示報告）。マスク/soft-gate/監査は Server Action 側が担う。
 */

type Card<T> = { id: string; item: T; accepted: boolean };

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

export function AllDraftPanel({
  scope,
  targetId,
  date,
  existingSchedules,
  existingNotices,
  existingAssignments,
}: {
  scope: string;
  targetId: string;
  date: string;
  existingSchedules: ScheduleItem[];
  existingNotices: NoticeItem[];
  existingAssignments: AssignmentItem[];
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warnSurfaces, setWarnSurfaces] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sCards, setSCards] = useState<Card<ScheduleItem>[]>([]);
  const [nCards, setNCards] = useState<Card<NoticeItem>[]>([]);
  const [aCards, setACards] = useState<Card<AssignmentItem>[]>([]);
  const idRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const speech = useSpeechToText("ja-JP");

  function nextId(): string {
    idRef.current += 1;
    return `o${idRef.current}`;
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
    setSCards([]);
    setNCards([]);
    setACards([]);
  }

  function applyOutcome(
    outcome:
      | {
          ok: true;
          schedules: ScheduleItem[];
          notices: NoticeItem[];
          assignments: AssignmentItem[];
        }
      | { ok: false; reason: string; suspectedSurfaces?: string[] },
  ) {
    if (outcome.ok) {
      setSCards(outcome.schedules.map((item) => ({ id: nextId(), item, accepted: true })));
      setNCards(outcome.notices.map((item) => ({ id: nextId(), item, accepted: true })));
      setACards(outcome.assignments.map((item) => ({ id: nextId(), item, accepted: true })));
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
      applyOutcome(await assistDraftAllAction(scope, targetId, memo, { acknowledgePii }));
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
      applyOutcome(await assistDraftAllFromFileAction(scope, targetId, fd, { acknowledgePii }));
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

  const sPicked = sCards.filter((c) => c.accepted).map((c) => c.item);
  const nPicked = nCards.filter((c) => c.accepted).map((c) => c.item);
  const aPicked = aCards.filter((c) => c.accepted).map((c) => c.item);
  const totalPicked = sPicked.length + nPicked.length + aPicked.length;
  const hasCards = sCards.length + nCards.length + aCards.length > 0;

  async function apply() {
    if (totalPicked === 0) {
      setMsg("反映する項目を1つ以上選んでください。");
      return;
    }
    setSaving(true);
    // ADR-036: per-section を順に保存（非原子・部分失敗は巻き戻さず明示報告。冪等 upsert ゆえ再実行可）。
    const results: { name: string; res: ActionResult<unknown> }[] = [];
    if (sPicked.length > 0) {
      results.push({
        name: "予定",
        res: await setScheduleAction(scope, targetId, date, [...existingSchedules, ...sPicked]),
      });
    }
    if (nPicked.length > 0) {
      results.push({
        name: "連絡",
        res: await setNoticesAction(scope, targetId, date, [...existingNotices, ...nPicked]),
      });
    }
    if (aPicked.length > 0) {
      results.push({
        name: "提出物",
        res: await setAssignmentsAction(scope, targetId, date, [
          ...existingAssignments,
          ...aPicked,
        ]),
      });
    }
    setSaving(false);
    const okNames = results.filter((r) => r.res.ok).map((r) => r.name);
    const failed = results.filter((r) => !r.res.ok);
    if (failed.length === 0) {
      setMsg(`反映しました（${okNames.join("・")}）。`);
      reset();
      setText("");
      clearFile();
    } else {
      const detail = failed
        .map((f) => `${f.name}: ${f.res.ok ? "" : f.res.error.message}`)
        .join(" / ");
      setMsg(`一部のみ反映しました。成功: ${okNames.join("・") || "なし"}。失敗 → ${detail}`);
    }
    // 成功分を盤面に反映（部分失敗でも成功 section は保存済み）。
    router.refresh();
  }

  return (
    <>
      <p className={styles.hint}>
        話す・入力する・ファイルから、AI が内容を「予定・連絡・提出物」に振り分けて下書きします。
        振り分けはその場で直せます。採用するものだけ反映してください。
      </p>

      <textarea
        className={styles.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="例: 明日は1限数学、体育館で全校集会。数学のワークP30を金曜まで提出。"
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
            {speech.listening ? (
              "● 録音中（停止）"
            ) : (
              <>
                <MicIcon /> 音声入力
              </>
            )}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.ghost}
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <FileIcon /> ファイルから
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || text.trim().length === 0}
          onClick={() => {
            clearFile();
            runText(false);
          }}
        >
          AIにおまかせで作る
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
        {busy ? <span className={styles.pulse}>● AI が振り分けて作成中…</span> : null}
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

      {hasCards ? (
        <div className={styles.proposal}>
          {renderGroup<ScheduleItem>(
            "予定",
            sCards,
            (item, set) => SCHEDULE_DRAFT_CONFIG.renderFields(item, set),
            setSCards,
          )}
          {renderGroup<NoticeItem>("連絡", nCards, renderNoticeFields, setNCards)}
          {renderGroup<AssignmentItem>(
            "提出物",
            aCards,
            (item, set) => ASSIGNMENT_DRAFT_CONFIG.renderFields(item, set),
            setACards,
          )}
          <div className={styles.row}>
            <button
              type="button"
              className={styles.primary}
              disabled={saving || busy}
              onClick={apply}
            >
              {saving ? "反映中…" : `反映する（${totalPicked}）`}
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

/** 連絡カードの編集フィールド（本文 + 重要トグル）。予定/提出物は SectionDraftPanel の config を再利用。 */
function renderNoticeFields(
  item: NoticeItem,
  set: (patch: Partial<NoticeItem>) => void,
): ReactNode {
  return (
    <>
      <textarea
        className={styles.cardText}
        value={item.text}
        rows={2}
        aria-label="連絡本文（編集できます）"
        onChange={(e) => set({ text: e.target.value })}
      />
      <button
        type="button"
        className={item.isHighlight ? styles.hiOn : styles.ghost}
        aria-pressed={item.isHighlight === true}
        onClick={() => set({ isHighlight: !item.isHighlight })}
      >
        {item.isHighlight ? "⚠ 重要" : "重要にする"}
      </button>
    </>
  );
}

/**
 * 1 セクション分のカード群を描画する（見出し + 採用数 + 各カードのフィールド/採用/削除）。0 件は見出しごと省略。
 */
function renderGroup<T>(
  label: string,
  cards: Card<T>[],
  renderFields: (item: T, set: (patch: Partial<T>) => void) => ReactNode,
  setCards: React.Dispatch<React.SetStateAction<Card<T>[]>>,
): ReactNode {
  if (cards.length === 0) {
    return null;
  }
  const accepted = cards.filter((c) => c.accepted).length;
  const update = (id: string, patch: Partial<T>) =>
    setCards((prev) =>
      prev.map((c) => (c.id === id ? { ...c, item: { ...c.item, ...patch } } : c)),
    );
  const toggle = (id: string, v: boolean) =>
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, accepted: v } : c)));
  const remove = (id: string) => setCards((prev) => prev.filter((c) => c.id !== id));
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div className={styles.proposalHead}>
        <strong>{label}</strong>
        <span className={styles.count}>
          採用 {accepted} / {cards.length} 件
        </span>
      </div>
      <ul className={styles.list}>
        {cards.map((c) => (
          <li key={c.id} className={`${styles.card} ${c.accepted ? "" : styles.cardOff}`}>
            {renderFields(c.item, (patch) => update(c.id, patch))}
            <div className={styles.cardActions}>
              <button
                type="button"
                className={c.accepted ? styles.acceptOn : styles.ghost}
                aria-pressed={c.accepted}
                onClick={() => toggle(c.id, !c.accepted)}
              >
                {c.accepted ? "✓ 採用" : "採用する"}
              </button>
              <button type="button" className={styles.ghost} onClick={() => remove(c.id)}>
                削除
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
