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
import { setAssignmentsAction, setNoticesAction } from "@/lib/editor/notice-assignment-actions";
import { assistDraftAllFromFileAction } from "@/lib/editor/assistant-actions";
import { setScheduleAction } from "@/lib/editor/schedule-actions";
import { formatSignageItem } from "@/lib/signage/section-format";
import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import { tokens } from "@kimiterrace/ui";
import { useCallback, useEffect, useRef, useState } from "react";

const { color, radius, fontSize } = tokens;

/**
 * 会話型 AI アシスタント UI shell（finding 2b・モック `teacher_ai_fullscreen_first` 準拠）。
 *
 * 「話す/書く → AI が下書き → 確認 → 反映」を**多ターン会話**で行う client 殻。状態遷移と SSE パースは
 * 純ロジック {@link "@/lib/editor/assistant-chat-client"} に委譲し（テスト済）、本体は描画と I/O に専念する。
 * バックエンドは AI レーンの `POST /api/editor/assistant/chat`（契約 = `assistant-chat-core` /
 * `docs/architecture/conversational-assistant-api.md`）。route 未着地の間は送信が `error` に倒れる
 * （入力・下書きは保持）。
 *
 * - **反映（保存）はこの API ではなく既存の per-section Server Action**（`setScheduleAction` /
 *   `setNoticesAction` / `setAssignmentsAction`）で行う（API は下書きのみ）。
 * - **パターン準拠（finding①）**: 許可セクションは `meta` でサーバが解決。pattern2 は `schedules` のみ
 *   提案し、来校者/呼び出しは「下の手入力フォームで追加」と促す（ADR-034: 氏名を AI に送らない）。
 * - 音声入力・ファイル取り込みは次増分（teacher-input の STT / 既存ファイル action を流用予定）。
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

  /** 新規送信: user ターンを積んで stream。 */
  const onSend = useCallback(() => {
    const content = input.trim();
    if (streamingRef.current || !content) return;
    streamingRef.current = true;
    setSaveMsg(null);
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

  /** 反映: 下書きを既存 per-section Server Action で盤面へ保存する（API は下書きのみ）。 */
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
  // pattern2 等で連絡/提出物が許可外のとき、来校者/呼び出しは手入力へ誘導する（ADR-034）。
  const restrictedToSchedules =
    state.allowedSections.length > 0 &&
    !state.allowedSections.includes("notices") &&
    !state.allowedSections.includes("assignments");

  return (
    <section aria-label="AIアシスタント" style={rootStyle}>
      <div style={threadStyle}>
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

        {draftHasItems(state.draft) ? (
          <DraftPreview
            draft={state.draft}
            done={state.status === "done"}
            saving={saving}
            saveMsg={saveMsg}
            onApply={onApply}
          />
        ) : null}

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

      <div style={composerStyle}>
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
          style={iconBtnStyle}
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
            style={stt.listening ? micActiveStyle : micStyle}
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
          style={sendBtnStyle}
          onClick={onSend}
          disabled={streaming || fileBusy || !input.trim()}
          aria-label="送信"
        >
          {fileBusy ? "読込中…" : "送信"}
        </button>
      </div>
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

function DraftPreview({
  draft,
  done,
  saving,
  saveMsg,
  onApply,
}: {
  draft: AssistantDraft;
  done: boolean;
  saving: boolean;
  saveMsg: string | null;
  onApply: () => void;
}) {
  return (
    <div style={draftCardStyle}>
      <div style={draftHeadStyle}>下書き（確認して反映）</div>
      <DraftSection title="予定" kind="schedules" items={draft.schedules} />
      <DraftSection title="連絡" kind="notices" items={draft.notices} />
      <DraftSection title="提出物" kind="assignments" items={draft.assignments} />
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.6rem" }}>
        <button type="button" style={applyBtnStyle} onClick={onApply} disabled={!done || saving}>
          {saving ? "反映中…" : "反映する"}
        </button>
        <span style={hintStyle}>直したい所は、そのまま話しかけてください。</span>
      </div>
      {saveMsg ? <p style={{ margin: "0.5rem 0 0", fontSize: fontSize.sm }}>{saveMsg}</p> : null}
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
    <div style={{ padding: "0.4rem 0", borderTop: `1px solid ${color.border}` }}>
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

const rootStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: `1px solid ${color.border}`,
  borderRadius: radius.lg,
  background: "#fff",
  overflow: "hidden",
  minHeight: "320px",
};
const threadStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: "0.6rem",
  padding: "0.9rem",
  background: color.bgSoft,
};
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
const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: fontSize.sm,
  color: color.dangerFg,
  background: color.dangerBg,
  border: `1px solid ${color.dangerBorder}`,
  borderRadius: radius.md,
  padding: "0.5rem 0.7rem",
};
const draftCardStyle: React.CSSProperties = {
  alignSelf: "stretch",
  background: "#fff",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  padding: "0.7rem 0.85rem",
};
const draftHeadStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  fontWeight: 600,
  marginBottom: "0.3rem",
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
const composerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  gap: "0.5rem",
  padding: "0.6rem 0.7rem",
  borderTop: `1px solid ${color.border}`,
  background: "#fff",
};
const iconBtnStyle: React.CSSProperties = {
  width: "40px",
  minHeight: "40px",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: "#fff",
  color: color.muted,
  fontSize: "1.2rem",
  cursor: "pointer",
  flex: "none",
};
const micStyle: React.CSSProperties = {
  width: "44px",
  minHeight: "44px",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: "#fff",
  color: color.ink,
  fontSize: "1.2rem",
  cursor: "pointer",
  flex: "none",
};
const micActiveStyle: React.CSSProperties = {
  ...micStyle,
  background: color.primary,
  color: "#fff",
  border: "none",
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
const sendBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.5rem 1.1rem",
  background: color.primary,
  color: "#fff",
  border: "none",
  borderRadius: radius.md,
  fontSize: "1rem",
  fontWeight: 600,
  cursor: "pointer",
  flex: "none",
};
const applyBtnStyle: React.CSSProperties = {
  minHeight: "44px",
  padding: "0.5rem 1.2rem",
  background: color.primary,
  color: "#fff",
  border: "none",
  borderRadius: radius.md,
  fontSize: "0.95rem",
  fontWeight: 600,
  cursor: "pointer",
};
