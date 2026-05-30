"use client";

import { rollbackContentAction } from "@/lib/contents/publish-actions";
import type { ContentVersionInfo } from "@kimiterrace/db";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F04.2: バージョンタイムライン (1-click rollback)。
 *
 * `content_versions` の全履歴を新しい順に並べ、各バージョンに「このバージョンに戻す」ボタンを
 * 置く。rollback は `rollbackContentAction` (PR #148) を呼び、履歴を消さず新バージョンとして
 * 積む (要件 F04.2)。最新バージョンには rollback ボタンを出さない (戻す意味がないため)。
 *
 * `versions` は呼出側 (getContentDetail) が version 降順で渡す前提 → 先頭が最新。
 */
export function VersionTimeline({
  contentId,
  versions,
  activeVersionId,
}: {
  contentId: string;
  versions: ContentVersionInfo[];
  activeVersionId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);

  function rollback(version: number) {
    setError(null);
    setBusyVersion(version);
    startTransition(async () => {
      const result = await rollbackContentAction(contentId, version);
      setBusyVersion(null);
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.message ?? "巻き戻しに失敗しました。");
      }
    });
  }

  if (versions.length === 0) {
    return <p style={emptyStyle}>まだバージョン履歴がありません（公開すると記録されます）。</p>;
  }

  return (
    <div>
      <ol style={listStyle}>
        {versions.map((v, index) => {
          const isLatest = index === 0;
          const isPublished = v.id === activeVersionId;
          return (
            <li key={v.id} style={itemStyle}>
              <div style={metaStyle}>
                <span style={versionLabelStyle}>v{v.version}</span>
                {isLatest ? <span style={tagStyle}>最新</span> : null}
                {isPublished ? <span style={publishedTagStyle}>公開中</span> : null}
                {v.diffSummary ? <span style={summaryStyle}>{v.diffSummary}</span> : null}
              </div>
              {isLatest ? null : (
                <button
                  type="button"
                  onClick={() => rollback(v.version)}
                  disabled={pending}
                  style={rollbackStyle}
                >
                  {pending && busyVersion === v.version ? "巻き戻し中…" : "このバージョンに戻す"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {error ? (
        <p role="alert" style={errorStyle}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.5rem 0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "6px",
};

const metaStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem" };

const versionLabelStyle: React.CSSProperties = { fontWeight: 700, fontSize: "0.9rem" };

const tagStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  padding: "0.05rem 0.4rem",
  borderRadius: "999px",
  background: "#dbeafe",
  color: "#1e40af",
};

const publishedTagStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  padding: "0.05rem 0.4rem",
  borderRadius: "999px",
  background: "#dcfce7",
  color: "#166534",
};

const summaryStyle: React.CSSProperties = { fontSize: "0.8rem", color: "#6b7280" };

const rollbackStyle: React.CSSProperties = {
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  padding: "0.3rem 0.7rem",
  fontSize: "0.82rem",
  cursor: "pointer",
};

const emptyStyle: React.CSSProperties = { color: "#6b7280", fontSize: "0.85rem" };

const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.85rem" };
