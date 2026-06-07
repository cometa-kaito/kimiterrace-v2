"use client";

import { assistDraftNoticesAction } from "@/lib/editor/assistant-actions";
import type { AssistDraftResult } from "@/lib/editor/assistant-core";
import type { NoticeItem } from "@/lib/editor/notice-assignment-core";
import { setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "./editor-assistant.module.css";

/** 提案リストの安定キー用に id を付与した連絡（保存時は id を無視して text/isHighlight のみ採用）。 */
type ProposedNotice = NoticeItem & { id: string };

/**
 * 段C: エディタの **AI アシスタント浮遊UI**（ユーザー要望 2026-06-07）。編集画面の右下に常駐するボタンを
 * 押すと浮遊パネルが開き、**話す（音声）/ 打つ（テキスト）→ AI が「連絡」を下書き → 確認 → 反映（保存）**
 * できる。保存は段A-2 の `setNoticesAction`（自校 RLS・監査）に委譲。AI 下書きは `assistDraftNoticesAction`
 * （PII マスク/soft-gate/監査/AI_ENABLED gate 済）。本MVP は連絡のみ（時間割/提出物は後続）。
 */
export function EditorAssistant({
  scope,
  targetId,
  date,
  existingNotices,
}: {
  scope: string;
  targetId: string;
  date: string;
  existingNotices: NoticeItem[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const [proposed, setProposed] = useState<ProposedNotice[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [warnSurfaces, setWarnSurfaces] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const speech = useSpeechToText("ja-JP");

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

  function runDraft(acknowledgePii: boolean) {
    setMsg(null);
    setWarnSurfaces(null);
    startDraft(async () => {
      const res: AssistDraftResult = await assistDraftNoticesAction(scope, targetId, text, {
        acknowledgePii,
      });
      if (res.ok) {
        setProposed(res.notices.map((n, i) => ({ ...n, id: `${i}-${n.text}` })));
        setSelected(new Set(res.notices.map((_, i) => i)));
      } else if (res.reason === "pii_warning") {
        setWarnSurfaces(res.suspectedSurfaces);
      } else {
        setMsg(MESSAGES[res.reason] ?? "うまくいきませんでした。");
      }
    });
  }

  function apply() {
    if (!proposed) return;
    const picked = proposed.filter((_, i) => selected.has(i));
    if (picked.length === 0) {
      setMsg("反映する連絡を1つ以上選んでください。");
      return;
    }
    startSave(async () => {
      const merged = [...existingNotices, ...picked];
      const res = await setNoticesAction(scope, targetId, date, merged);
      if (res.ok) {
        setMsg("連絡に反映しました。");
        setProposed(null);
        setText("");
        router.refresh();
      } else {
        setMsg(res.error.message);
      }
    });
  }

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
            <strong>AI で連絡を作成</strong>
            <button type="button" className={styles.ghost} onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>

          <p className={styles.hint}>
            話すか入力すると、AI が「連絡」の下書きを作ります。確認して反映してください。
          </p>

          <textarea
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例: 明日は短縮授業で午後は部活なし。図書室の返却は金曜まで。"
            rows={3}
          />

          <div className={styles.row}>
            {speech.supported ? (
              <button
                type="button"
                className={speech.listening ? styles.micOn : styles.ghost}
                onClick={toggleMic}
              >
                {speech.listening ? "● 録音中（停止）" : "🎤 音声入力"}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.primary}
              disabled={drafting || text.trim().length === 0}
              onClick={() => runDraft(false)}
            >
              {drafting ? "作成中…" : "AIで連絡を作る"}
            </button>
          </div>
          {speech.listening ? <p className={styles.interim}>{speech.interim}</p> : null}

          {warnSurfaces ? (
            <div className={styles.warn}>
              個人名らしき語が含まれている可能性があります（{warnSurfaces.join("、")}）。
              掲示に個人名を載せないのが原則です。承知の上で続けますか？
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={drafting}
                  onClick={() => runDraft(true)}
                >
                  {drafting ? "作成中…" : "承知して続ける"}
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

          {proposed ? (
            <div className={styles.proposal}>
              <strong>AI の下書き（反映するものを選択）</strong>
              <ul className={styles.list}>
                {proposed.map((n, i) => (
                  <li key={n.id} className={styles.item}>
                    <label className={styles.itemLabel}>
                      <input
                        type="checkbox"
                        checked={selected.has(i)}
                        onChange={(e) => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) {
                              next.add(i);
                            } else {
                              next.delete(i);
                            }
                            return next;
                          });
                        }}
                      />
                      <span>
                        {n.isHighlight ? "⚠ " : ""}
                        {n.text}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className={styles.row}>
                <button type="button" className={styles.primary} disabled={saving} onClick={apply}>
                  {saving ? "反映中…" : "連絡に反映する"}
                </button>
                <button type="button" className={styles.ghost} onClick={() => setProposed(null)}>
                  破棄
                </button>
              </div>
            </div>
          ) : null}

          {msg ? <p className={styles.msg}>{msg}</p> : null}
        </div>
      ) : null}
    </>
  );
}

const MESSAGES: Record<string, string> = {
  forbidden: "権限がありません。",
  disabled: "AI 機能が現在無効です。",
  rate_limited: "短時間に使いすぎました。少し待って再度お試しください。",
  pii_leak: "個人情報が含まれる可能性があるため中止しました。",
  empty: "メモを入力してください。",
  too_long: "入力が長すぎます。短くしてください。",
  no_result: "うまく作成できませんでした。言い換えて再度お試しください。",
  error: "エラーが発生しました。もう一度お試しください。",
};
