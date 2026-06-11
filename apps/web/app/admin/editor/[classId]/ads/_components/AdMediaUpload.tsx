"use client";

import {
  AD_MEDIA_ACCEPT,
  ALLOWED_AD_MEDIA_UPLOAD_TYPES,
  type AdMediaTypeValue,
  adUploadErrorMessage,
} from "@/lib/ads/media-upload-validation";
import { MAX_UPLOAD_BYTES } from "@/lib/teacher-input/upload-validation";
import { useId, useRef, useState, useTransition } from "react";

/**
 * 広告メディア（PNG/JPEG）の **アップロード UI**（#46 / ADR-037）。
 *
 * ファイルを選び `POST /api/ads/media`（multipart）へ送り、成功すると **同一オリジン配信 URL**
 * （`/ad-media/<key>`）を `onUploaded(url, mediaType)` で親（AdForm）へ返す。親はその URL を
 * メディア URL 欄へ反映する（広告主が GCS の URL を知らなくても `/admin` だけで完結する）。
 *
 * 認可・検証・保存・偽装検知はサーバー（route）と RLS が担保するので、ここは入力収集 + 早期 UX 検証
 * （MIME / サイズ）+ 結果表示に徹する（FileUploadForm と同方針）。信頼境界はサーバー側。
 */

const ALLOWED_MIME = new Set(ALLOWED_AD_MEDIA_UPLOAD_TYPES.map((t) => t.mime));
const MEDIA_TYPES = new Set<string>(ALLOWED_AD_MEDIA_UPLOAD_TYPES.map((t) => t.mediaType));

/** 受口レスポンスを検証する: `url` は同一オリジン配信パス、`mediaType` は許可種別のみ受ける。 */
function parseUploadResponse(data: unknown): { url: string; mediaType: AdMediaTypeValue } | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const { url, mediaType } = data as { url?: unknown; mediaType?: unknown };
  if (typeof url !== "string" || !url.startsWith("/ad-media/")) {
    return null;
  }
  if (typeof mediaType !== "string" || !MEDIA_TYPES.has(mediaType)) {
    return null;
  }
  return { url, mediaType: mediaType as AdMediaTypeValue };
}

export function AdMediaUpload({
  onUploaded,
}: {
  /** アップロード成功時に配信 URL と media_type を親へ渡す。 */
  onUploaded: (url: string, mediaType: AdMediaTypeValue) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okName, setOkName] = useState<string | null>(null);

  function onUpload() {
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("ファイルを選択してください。");
      return;
    }
    // クライアント側でも MIME / サイズを早期チェックして無駄な往復を避ける（最終判定はサーバー）。
    if (!ALLOWED_MIME.has(file.type)) {
      setError("対応していない形式です（PNG / JPEG の画像のみ）。");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("ファイルが大きすぎます（上限 50MB）。");
      return;
    }
    setError(null);
    setOkName(null);
    startTransition(async () => {
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/ads/media", { method: "POST", body });
        if (!res.ok) {
          setError(adUploadErrorMessage(res.status));
          return;
        }
        // レスポンス形を検証してから親へ渡す（無検証キャストを避ける・#828 Reviewer M1）。
        const data: unknown = await res.json();
        const parsed = parseUploadResponse(data);
        if (!parsed) {
          setError("アップロード結果を解釈できませんでした。");
          return;
        }
        onUploaded(parsed.url, parsed.mediaType);
        setOkName(file.name);
        if (inputRef.current) {
          inputRef.current.value = "";
        }
      } catch {
        setError("通信に失敗しました。時間をおいて再試行してください。");
      }
    });
  }

  return (
    <div style={wrapStyle}>
      <label htmlFor={inputId} style={labelStyle}>
        画像をアップロード（PNG / JPEG）
      </label>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept={AD_MEDIA_ACCEPT}
          disabled={pending}
          style={{ fontSize: "0.85rem" }}
        />
        <button type="button" onClick={onUpload} disabled={pending} style={uploadBtnStyle}>
          {pending ? "アップロード中…" : "アップロード"}
        </button>
      </div>
      <p style={hintStyle}>
        アップロードすると下のメディア URL に自動入力されます（動画は URL を直接入力してください）。
      </p>
      {error ? (
        <p role="alert" style={{ color: "#b91c1c", fontSize: "0.85rem", margin: "0.4rem 0 0" }}>
          {error}
        </p>
      ) : null}
      {okName ? (
        <p style={{ color: "#15803d", fontSize: "0.85rem", margin: "0.4rem 0 0" }}>
          「{okName}」をアップロードしました。
        </p>
      ) : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  flex: "1 1 100%",
  border: "1px dashed #d1d5db",
  borderRadius: "6px",
  padding: "0.6rem 0.7rem",
  background: "#fafafa",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.85rem",
  fontWeight: 600,
  marginBottom: "0.4rem",
};
const hintStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.78rem",
  margin: "0.4rem 0 0",
};
const uploadBtnStyle: React.CSSProperties = {
  padding: "0.35rem 0.8rem",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
