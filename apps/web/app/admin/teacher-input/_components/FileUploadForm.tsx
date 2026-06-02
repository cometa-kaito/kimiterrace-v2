"use client";

import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  uploadErrorMessage,
} from "@/lib/teacher-input/upload-validation";
import { useRef, useState, useTransition } from "react";
import { CreateDraftButton } from "./CreateDraftButton";

/**
 * F01 (#509 S3b): 教員ファイルアップロードの入力フォーム。
 *
 * 選択ファイルを `POST /api/teacher-inputs/upload` (multipart) に送る。成功すると teacher_input が
 * 作成され、続けて「編集して公開」(CreateDraftButton) で下書き content を作りエディタへ進める。
 * 画像 (PNG/JPEG) は OCR 配線前のため本文テキスト化が保留 (pending_ocr) になる旨を表示する。
 *
 * クライアント側でも MIME/サイズを早期チェックして無駄な往復を避けるが、最終判定はサーバー
 * (upload route の allowlist + 50MB) が行う (信頼境界はサーバー側)。
 */

const ACCEPT = ALLOWED_UPLOAD_TYPES.map((t) => t.mime).join(",");
const ALLOWED_MIME = new Set(ALLOWED_UPLOAD_TYPES.map((t) => t.mime));

type UploadOk = { inputId: string; pendingOcr: boolean };

export function FileUploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<UploadOk | null>(null);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("ファイルを選択してください。");
      return;
    }
    if (!ALLOWED_MIME.has(file.type)) {
      setError("対応していない形式です（PDF / Word / Excel / PNG / JPEG のみ）。");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("ファイルが大きすぎます（上限 50MB）。");
      return;
    }
    setError(null);
    setDone(null);
    startTransition(async () => {
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/teacher-inputs/upload", { method: "POST", body });
        if (!res.ok) {
          setError(uploadErrorMessage(res.status));
          return;
        }
        const data = (await res.json()) as {
          input: { id: string };
          extraction?: { status: string };
        };
        setDone({ inputId: data.input.id, pendingOcr: data.extraction?.status === "pending_ocr" });
        if (inputRef.current) {
          inputRef.current.value = "";
        }
      } catch {
        setError("通信に失敗しました。時間をおいて再試行してください。");
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{ border: "1px solid #e5e7eb", borderRadius: "0.5rem", padding: "1rem" }}
    >
      <label
        htmlFor="teacher-upload-file"
        style={{ display: "block", fontWeight: 600, marginBottom: "0.4rem" }}
      >
        ファイルから取り込む（PDF / Word / Excel / 画像）
      </label>
      <input
        id="teacher-upload-file"
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        style={{ fontSize: "0.9rem" }}
      />
      <div style={{ marginTop: "0.6rem" }}>
        <button
          type="submit"
          disabled={pending}
          style={{
            fontSize: "0.9rem",
            padding: "0.35rem 0.9rem",
            borderRadius: "0.25rem",
            border: "1px solid #2563eb",
            background: pending ? "#93c5fd" : "#2563eb",
            color: "#fff",
            cursor: pending ? "default" : "pointer",
          }}
        >
          {pending ? "アップロード中…" : "アップロード"}
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.85rem", margin: "0.5rem 0 0" }}>
          {error}
        </p>
      )}
      {done && (
        <div style={{ marginTop: "0.6rem", fontSize: "0.85rem" }}>
          <p style={{ margin: "0 0 0.4rem", color: "#15803d" }}>
            アップロードしました。
            {done.pendingOcr
              ? "（画像の文字起こしは準備中です。文章ファイルはそのまま下書きにできます）"
              : "内容を下書きにして編集できます。"}
          </p>
          {!done.pendingOcr && <CreateDraftButton inputId={done.inputId} />}
        </div>
      )}
    </form>
  );
}
