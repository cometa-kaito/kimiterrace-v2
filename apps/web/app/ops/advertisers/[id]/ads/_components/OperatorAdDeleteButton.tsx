"use client";

import { deleteOperatorAdAction } from "@/lib/system-admin/operator-ads-actions";
import { ConfirmDialog, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F10 / #46: 運営広告の削除ボタン。**Client Component** — 共通 `ConfirmDialog`(danger) で確認してから
 * `deleteOperatorAdAction` を呼ぶ。削除は advertiser_id 有りの運営広告のみ（学校クラス広告は対象外、
 * action 側で保証）。成功で成功トースト + 一覧再取得。
 */
export function OperatorAdDeleteButton({ adId, label }: { adId: string; label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await deleteOperatorAdAction(adId);
      setConfirmOpen(false);
      if (res.ok) {
        toast("広告を削除しました", { tone: "success" });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
        aria-label={`${label} を削除`}
        style={btnStyle}
      >
        削除
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title="この広告を削除しますか？"
        description="サイネージから即時に表示されなくなります。"
        confirmLabel="削除する"
        pending={pending}
        onConfirm={run}
        onCancel={() => setConfirmOpen(false)}
      />
    </span>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "0.2rem 0.6rem",
  background: "#fff",
  color: "#b91c1c",
  border: "1px solid #fecaca",
  borderRadius: "6px",
  fontSize: "0.8rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.75rem" };
