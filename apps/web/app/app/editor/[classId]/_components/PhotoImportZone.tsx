"use client";

import {
  type PhotoImportErrorReason,
  photoImportChatMessageAction,
} from "@/lib/editor/photo-import-actions";
import { type DragEvent, useCallback, useRef, useState } from "react";
import styles from "./PhotoImportZone.module.css";
import { usePhotoImport } from "./photo-import-context";

/**
 * P1 写真取込のゾーン1 導線（設計 D6: planActions 隣「プリント/写真から取り込む」）。
 *
 * - **PC**: クリック/Enter/Space でファイル選択、ドラッグ＆ドロップはエンハンス（#1286 カレンダー取込
 *   ドロップゾーンと同作法の小型版）。
 * - **スマホ**: `<input type="file" accept="image/png,image/jpeg" capture="environment">` で背面カメラを
 *   直起動する（教員の実機はスマホが多い・D6）。iOS は accept を jpeg/png に絞ると HEIC を JPEG へ
 *   自動変換して渡す（サーバの MIME allowlist と整合）。
 * - 成功時は {@link usePhotoImport} に注入ターンを積むだけ（チャットが開いて自動送信）。エラーは
 *   その場に短文で表示する（reason → 文言の写像は本コンポーネント責務・PII/本文は出さない）。
 *
 * AI 無効環境では親（page.tsx・isAiEnabled()）が本導線ごと出さない（D7）。
 */

/** 失敗理由 → 教員向け文言（本文/ファイル名は出さない）。 */
const ERROR_TEXT: Record<PhotoImportErrorReason, string> = {
  empty: "画像を選択してください。",
  too_large: "10MB 以下の画像にしてください。",
  unsupported_format: "PNG / JPEG の画像のみ取り込めます。",
  extract_failed: "画像を読み取れませんでした。撮り直してお試しください。",
  no_text: "文字を読み取れませんでした。プリント全体が写るように撮り直してください。",
  rate_limited: "利用が集中しています。少し待ってからもう一度お試しください。",
  forbidden: "取り込みに失敗しました。ログインし直してください。",
  disabled: "AI 機能が現在無効です。",
  error: "取り込みに失敗しました。もう一度お試しください。",
};

export function PhotoImportZone({ classId }: { classId: string }) {
  const photoImport = usePhotoImport();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** ファイル受領の単一入口（クリック選択 = input change / D&D = drop の両経路）。 */
  const onFile = useCallback(
    async (file: File) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await photoImportChatMessageAction("class", classId, fd);
        if (r.ok) {
          photoImport?.submitPhotoMessage(r.message);
        } else {
          setError(ERROR_TEXT[r.reason]);
        }
      } catch {
        setError(ERROR_TEXT.error);
      } finally {
        setBusy(false);
      }
    },
    [busy, classId, photoImport],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void onFile(file);
    },
    [onFile],
  );

  return (
    <div>
      {/* ネイティブ input は機能だけ残して視覚的に隠す（#1286 と同作法）。capture でスマホはカメラ直起動。 */}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className={dragOver ? `${styles.zone} ${styles.zoneActive}` : styles.zone}
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        aria-busy={busy}
      >
        <span>
          {busy
            ? "画像を読み取っています…"
            : dragOver
              ? "ここにドロップして取り込む"
              : "📄 プリント/写真から取り込む"}
        </span>
        <span className={`${styles.hint} ${styles.dropHint}`}>画像のドロップでも取り込めます</span>
      </button>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
