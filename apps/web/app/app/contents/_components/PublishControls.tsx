"use client";

import { publishContentAction, unpublishContentAction } from "@/lib/contents/publish-actions";
import type { ContentStatusValue } from "@/lib/contents/publish-view";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F04: 即公開 / 非公開コントロール。
 *
 * 公開操作を Server Action (`publishContentAction` / `unpublishContentAction`、PR #148) に配線する。
 * 承認フロー無しの即公開なので、押下→即反映 (成功時は `router.refresh()` でサーバーデータ再取得)。
 * 失敗は `ActionResult` のメッセージをそのまま表示する (例外は actions 側で再 throw されるため
 * ここには来ない)。
 *
 * **ADR-030 (#426) PII soft-gate**: 公開時に本文へ氏名らしき高確信パターンが検出されると Server Action が
 * `code:"pii_warning"` を返す。その場合は **hard-block せず**、疑わしい表層を提示して「承知の上で公開する」
 * 明示 override を促す (override は server 側で公開 + 監査記録)。誤検出で正当な掲示を阻害しないため warn 方式。
 */
export function PublishControls({
  contentId,
  status,
}: {
  contentId: string;
  status: ContentStatusValue;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // PII soft-gate の warn 状態 (検出された疑わしい表層)。null = 警告なし。
  const [piiSuspects, setPiiSuspects] = useState<readonly string[] | null>(null);

  function run(action: (id: string) => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    setPiiSuspects(null);
    startTransition(async () => {
      const result = await action(contentId);
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.message ?? "操作に失敗しました。");
      }
    });
  }

  /** 公開実行。`acknowledgePii` で override (氏名警告を承知の上で公開)。 */
  function publish(acknowledgePii: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await publishContentAction(
        contentId,
        acknowledgePii ? { acknowledgePii: true } : undefined,
      );
      if (result.ok) {
        setPiiSuspects(null);
        router.refresh();
      } else if (result.code === "pii_warning") {
        // warn のみ: 公開せず override を促す (ADR-030)。
        setPiiSuspects(result.suspects ?? []);
      } else {
        setPiiSuspects(null);
        setError(result.message ?? "操作に失敗しました。");
      }
    });
  }

  const isPublished = status === "published";

  return (
    <div style={wrapStyle}>
      {isPublished ? (
        <button
          type="button"
          onClick={() => run(unpublishContentAction)}
          disabled={pending}
          style={unpublishStyle}
        >
          {pending ? "処理中…" : "非公開にする"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => publish(false)}
          disabled={pending}
          style={publishStyle}
        >
          {pending ? "処理中…" : "公開する"}
        </button>
      )}
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
      {piiSuspects !== null ? (
        <div role="alert" style={piiPanelStyle}>
          <p style={{ margin: "0 0 0.4rem", fontWeight: 600 }}>個人名らしき表現が含まれています</p>
          <p style={{ margin: "0 0 0.4rem" }}>
            公開掲示物に個別の生徒・保護者氏名を載せない方針です。内容をご確認ください。
          </p>
          {piiSuspects.length > 0 ? (
            <p style={{ margin: "0 0 0.6rem" }}>
              疑わしい箇所: <span style={{ fontWeight: 600 }}>{piiSuspects.join("、")}</span>
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => publish(true)}
              disabled={pending}
              style={overrideStyle}
            >
              {pending ? "処理中…" : "承知の上で公開する"}
            </button>
            <button
              type="button"
              onClick={() => setPiiSuspects(null)}
              disabled={pending}
              style={cancelStyle}
            >
              編集に戻る
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.75rem",
};

const publishStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  padding: "0.45rem 1.1rem",
  fontWeight: 600,
  cursor: "pointer",
};

/** PII warn パネル (黄系で注意喚起、エラー赤とは区別)。 */
const piiPanelStyle: React.CSSProperties = {
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: "8px",
  padding: "0.75rem 1rem",
  fontSize: "0.9rem",
  color: "#92400e",
  maxWidth: "40rem",
};

const overrideStyle: React.CSSProperties = {
  background: "#b45309",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  padding: "0.4rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};

const cancelStyle: React.CSSProperties = {
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  padding: "0.4rem 1rem",
  fontWeight: 600,
  cursor: "pointer",
};

const unpublishStyle: React.CSSProperties = {
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  borderRadius: "6px",
  padding: "0.45rem 1.1rem",
  fontWeight: 600,
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.85rem", margin: 0 };
