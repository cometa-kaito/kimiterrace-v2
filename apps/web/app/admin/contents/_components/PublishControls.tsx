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

  function run(action: (id: string) => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action(contentId);
      if (result.ok) {
        router.refresh();
      } else {
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
          onClick={() => run(publishContentAction)}
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
    </div>
  );
}

const wrapStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem" };

const publishStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  padding: "0.45rem 1.1rem",
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
