"use client";

import { useSpeechToText } from "@/lib/teacher-input/use-speech-to-text";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * F02 (#38): 教員の 音声 / チャット入力 composer。
 *
 * - チャット欄 (textarea) に直接打つ or マイクで音声入力 (Web Speech API、端末ローカル)。
 * - 送信は既存の `POST /api/teacher-inputs` (ADR-008 Route Handler) に**確定テキストのみ**を渡す。
 *   音声データはサーバーに送らない (F02 受け入れ条件 / NFR03)。
 * - `inputType` は voice を一度でも使ったかで voice/chat を決める (監査・分析用、F02 入力種別)。
 * - 抽出 (F03) → 編集 UI (F01) への接続は後続スライス。本スライスは入力の作成までを担う。
 */

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; id: string }
  | { kind: "error"; message: string };

const MAX_LEN = 20_000;

export function TeacherInputComposer() {
  const [text, setText] = useState("");
  const [usedVoice, setUsedVoice] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ kind: "idle" });
  const { supported, listening, transcript, interim, error, start, stop, reset } =
    useSpeechToText();
  // 音声の確定テキストは「前回までに取り込んだ長さ」との差分だけを textarea に追記する
  // (textarea の手動編集と両立させるため、transcript で全置換しない)。
  const consumedRef = useRef(0);

  useEffect(() => {
    if (transcript.length > consumedRef.current) {
      const delta = transcript.slice(consumedRef.current);
      consumedRef.current = transcript.length;
      setUsedVoice(true);
      setText((prev) => (prev + delta).slice(0, MAX_LEN));
    }
  }, [transcript]);

  const toggleMic = () => {
    if (listening) {
      stop();
    } else {
      start();
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || submit.kind === "submitting") {
      return;
    }
    if (listening) {
      stop();
    }
    setSubmit({ kind: "submitting" });
    try {
      const res = await fetch("/api/teacher-inputs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inputType: usedVoice ? "voice" : "chat",
          transcript: trimmed,
          status: "ready",
        }),
      });
      if (!res.ok) {
        setSubmit({ kind: "error", message: `送信に失敗しました (${res.status})。` });
        return;
      }
      const row: { id?: string } = await res.json();
      setSubmit({ kind: "done", id: row.id ?? "" });
      setText("");
      setUsedVoice(false);
      consumedRef.current = 0;
      reset();
    } catch {
      setSubmit({ kind: "error", message: "ネットワークエラーが発生しました。" });
    }
  };

  return (
    <form onSubmit={onSubmit}>
      <textarea
        aria-label="連絡内容"
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, MAX_LEN))}
        placeholder="例: 明日 10 時から体育館で進路説明会"
        rows={6}
        style={{
          width: "100%",
          padding: "0.6rem",
          fontSize: "1rem",
          border: "1px solid #d1d5db",
          borderRadius: "0.4rem",
          resize: "vertical",
        }}
      />
      {listening && interim ? (
        <p style={{ color: "#6b7280", fontSize: "0.85rem", margin: "0.25rem 0" }}>
          認識中: {interim}
        </p>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.85rem", margin: "0.25rem 0" }}>
          {error === "not-allowed"
            ? "マイクの使用が許可されていません。ブラウザの権限を確認してください。"
            : `音声入力エラー: ${error}`}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center" }}>
        {supported ? (
          <button
            type="button"
            onClick={toggleMic}
            aria-pressed={listening}
            style={{
              padding: "0.5rem 0.9rem",
              borderRadius: "0.4rem",
              border: "1px solid #d1d5db",
              background: listening ? "#fee2e2" : "#f9fafb",
              cursor: "pointer",
            }}
          >
            {listening ? "■ 停止" : "🎤 音声入力"}
          </button>
        ) : (
          <span style={{ color: "#9ca3af", fontSize: "0.8rem" }}>
            このブラウザは音声入力に未対応です（チャット入力は利用できます）。
          </span>
        )}
        <button
          type="submit"
          disabled={!text.trim() || submit.kind === "submitting"}
          style={{
            padding: "0.5rem 1.1rem",
            borderRadius: "0.4rem",
            border: "none",
            background: !text.trim() || submit.kind === "submitting" ? "#93c5fd" : "#2563eb",
            color: "#fff",
            cursor: !text.trim() || submit.kind === "submitting" ? "default" : "pointer",
          }}
        >
          {submit.kind === "submitting" ? "送信中…" : "送信"}
        </button>
      </div>

      {submit.kind === "done" ? (
        <output
          style={{ display: "block", color: "#15803d", fontSize: "0.9rem", marginTop: "0.6rem" }}
        >
          入力を受け付けました。AI が内容を整理しています。{" "}
          {/* 送信後に状況を追える導線（旧: 確認メッセージのみで宙ぶらり）。履歴で AI 整理の進捗を確認できる。 */}
          <Link
            href="/admin/teacher-input/history"
            style={{ color: "#2563eb", textDecoration: "underline" }}
          >
            入力履歴で状況を確認できます
          </Link>
          。
        </output>
      ) : null}
      {submit.kind === "error" ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.9rem", marginTop: "0.6rem" }}>
          {submit.message}
        </p>
      ) : null}
    </form>
  );
}
