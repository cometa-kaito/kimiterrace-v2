"use client";

import { createDraftFromInputAction } from "@/lib/teacher-input/draft-actions";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F01/F02 (#509 S3b): 教員入力の transcript から下書き content を作成し、編集エディタへ遷移するボタン。
 *
 * `createDraftFromInputAction` を呼び、成功したら `/app/contents/{contentId}` へ push する
 * (既存エディタで編集 → 公開)。失敗時はメッセージを表示。色だけに依存しない文言ベースの状態表示 (NFR05)。
 */
export function CreateDraftButton({ inputId }: { inputId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await createDraftFromInputAction(inputId);
      if (res.ok) {
        router.push(`/app/contents/${res.contentId}`);
      } else {
        setError(res.message);
      }
    });
  }

  return (
    <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
      <button
        type="button"
        onClick={run}
        disabled={pending}
        style={{
          fontSize: "0.8rem",
          padding: "0.2rem 0.6rem",
          borderRadius: "0.25rem",
          border: "1px solid #2563eb",
          background: pending ? "#93c5fd" : "#2563eb",
          color: "#fff",
          cursor: pending ? "default" : "pointer",
        }}
      >
        {pending ? "作成中…" : "編集して公開"}
      </button>
      {error && (
        <span role="alert" style={{ color: "#b91c1c", fontSize: "0.8rem" }}>
          {error}
        </span>
      )}
    </span>
  );
}
