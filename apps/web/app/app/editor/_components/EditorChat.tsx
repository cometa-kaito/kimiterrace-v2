"use client";

import {
  applyChatFrame,
  beginUserTurn,
  type ChatState,
  initialChatState,
  parseSseFrames,
} from "@/lib/editor/assistant-chat-client";
import {
  type AssistantChatRequestBody,
  type AssistantDraft,
  draftHasItems,
} from "@/lib/editor/assistant-chat-core";
import { assistDraftAllFromFileAction } from "@/lib/editor/assistant-actions";
import { setAssignmentsAction, setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import { formatSignageItem } from "@/lib/signage/section-format";
import { sttErrorHint } from "@/lib/teacher-input/stt-error-hint";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { tokens } from "@kimiterrace/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
const GREETING =
  "今日の連絡、話しかけてください。話す・書く・ファイルでOK。予定・連絡・提出物にまとめて下書きします。";

export function EditorChat({
  scope,
  targetId,
  date,
  initialDraft,
}: {
  scope: string;
  targetId: string;
  date: string;
  initialDraft?: AssistantDraft;
}) {
  const [state, setState] = useState<ChatState>(() => initialChatState(initialDraft));
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // 会話インラインの確認カードを閉じたか（「直す」or 反映成功で閉じ、次の送信/取込で再表示）。
  const [confirmHidden, setConfirmHidden] = useState(false);
  const streamingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const stt = useSpeechToText();

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
      try {
        const res = await fetch(
          `/api/editor/assistant/chat?scope=${encodeURIComponent(scope)}&targetId=${encodeURIComponent(targetId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
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
      } catch {
        setState((s) => ({ ...s, status: "error", error: { reason: "stream_failed" } }));
      } finally {
        streamingRef.current = false;
      }
    },
    [scope, targetId],
  );

  /** 新規送信: user ターンを積んで stream。新しいターンなので前の確認カードは再表示可に戻す。 */
  const onSend = useCallback(() => {
    const content = input.trim();
    if (streamingRef.current || !content) return;
    streamingRef.current = true;
    setSaveMsg(null);
    setConfirmHidden(false);
    const base = beginUserTurn(state, content);
    setInput("");
    void stream(base, false);
  }, [input, state, stream]);

  /** PII 警告の「承知して送信」: 直近の messages をそのまま acknowledgePii=true で再送（user ターンは積まない）。 */
  const onAcknowledge = useCallback(() => {
    if (streamingRef.current) return;
    streamingRef.current = true;
    void stream(state, true);
  }, [state, stream]);

  /** 反映: 下書きを既存 per-section Server Action で盤面へ保存する（API は下書きのみ）。成功で確認カードを閉じる。 */
  const onApply = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setSaveMsg(null);
    const d = state.draft;
    try {
      const results = await Promise.all([
        d.schedules.length ? setScheduleAction(scope, targetId, date, d.schedules) : null,
        d.notices.length ? setNoticesAction(scope, targetId, date, d.notices) : null,
        d.assignments.length ? setAssignmentsAction(scope, targetId, date, d.assignments) : null,
      ]);
      const failed = results.some((r) => r !== null && !r.ok);
      setSaveMsg(
        failed ? "一部の反映に失敗しました。もう一度お試しください。" : "盤面に反映しました。",
      );
      if (!failed) {
        setConfirmHidden(true);
      }
    } catch {
      setSaveMsg("反映に失敗しました。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  }, [saving, state.draft, scope, targetId, date]);

  /** ファイル取り込み: PDF/Word/Excel/画像を既存 action で全セクション下書きに（非ストリーミング・保存しない）。 */
  const onFile = useCallback(
    async (file: File) => {
      if (streamingRef.current || fileBusy) return;
      setFileBusy(true);
      setSaveMsg(null);
      setConfirmHidden(false);
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
  // 会話インラインの確認カード: AI が下書きをまとめ終え（done）、内容があり、未確定（閉じてない）とき。
  const showConfirm = state.status === "done" && draftHasItems(state.draft) && !confirmHidden;

  return (
    <section aria-label="AIアシスタント" className={styles.chat}>
      <div className={styles.thread}>
        <Bubble from="assistant">{GREETING}</Bubble>
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
            <div style={{ fontSize: fontSize.sm, marginBottom: "0.5rem" }}>
              下書きにまとめました。
              <span style={{ fontWeight: 700 }}>この内容で反映してよいですか？</span>
            </div>
            <DraftSection title="予定" kind="schedules" items={state.draft.schedules} />
            <DraftSection title="連絡" kind="notices" items={state.draft.notices} />
            <DraftSection title="提出物" kind="assignments" items={state.draft.assignments} />
            <div style={confirmActionsStyle}>
              <button
                type="button"
                className={`${styles.btn} ${styles.apply}`}
                onClick={onApply}
                disabled={saving}
              >
                {saving ? "反映中…" : "反映する"}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.ghost}`}
                onClick={() => setConfirmHidden(true)}
                disabled={saving}
              >
                直す
              </button>
            </div>
          </div>
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
          <p style={errorStyle}>{otherError.message ?? errorText(otherError.reason)}</p>
        ) : null}
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
          style={inputStyle}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="話す・書く・ファイルで…（⌘/Ctrl+Enter で送信）"
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
            🎤
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.btn} ${styles.send}`}
          onClick={onSend}
          disabled={streaming || fileBusy || !input.trim()}
          aria-label="送信"
        >
          {fileBusy ? "読込中…" : "送信"}
        </button>
      </div>

      {/* 音声入力が実際に失敗したときだけ、マイク直下に短いヒントを出す（role=status で読み上げ）。 */}
      {micHint ? (
        <p role="status" style={micHintStyle}>
          {micHint}
        </p>
      ) : null}
    </section>
  );
}

function Bubble({ from, children }: { from: "user" | "assistant"; children: React.ReactNode }) {
  const isUser = from === "user";
  return (
    <div style={isUser ? userBubbleStyle : assistantBubbleStyle}>
      <span>{children}</span>
    </div>
  );
}

function DraftSection({
  title,
  kind,
  items,
}: {
  title: string;
  kind: "schedules" | "notices" | "assignments";
  items: readonly unknown[];
}) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div style={{ padding: "0.3rem 0", borderTop: `1px solid ${color.border}` }}>
      <div style={{ fontSize: fontSize.xs, color: color.muted }}>{title}</div>
      <ul style={{ margin: "0.2rem 0 0", paddingLeft: "1.1rem", display: "grid", gap: "0.15rem" }}>
        {items.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静的下書きの描画
          <li key={i} style={{ fontSize: fontSize.sm }}>
            {formatSignageItem(kind, item).text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 拒否理由 → 教員向け文言。 */
function errorText(reason: string): string {
  switch (reason) {
    case "rate_limited":
      return "混み合っています。少し待ってからもう一度お試しください。";
    case "no_result":
      return "うまくまとめられませんでした。言い方を変えてもう一度お試しください。";
    case "empty":
      return "内容を入力してください。";
    case "too_long":
      return "入力が長すぎます。短く分けてお試しください。";
    default:
      return "送信に失敗しました。もう一度お試しください。";
  }
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
const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.dangerFg,
  background: color.dangerBg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.md,
  padding: "0.5rem 0.7rem",
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
const inputStyle: React.CSSProperties = {
  flex: 1,
  minHeight: "44px",
  maxHeight: "140px",
  padding: "0.6rem 0.8rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  fontSize: "1rem",
  lineHeight: 1.5,
  resize: "vertical",
  fontFamily: "inherit",
};
