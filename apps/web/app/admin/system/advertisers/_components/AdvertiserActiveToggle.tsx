"use client";

import { setAdvertiserActiveAction } from "@/lib/system-admin/advertisers-actions";
import { ConfirmDialog, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F10 (#46): 広告主の稼働状態トグル。**Client Component** — 一覧の各行で「停止 / 再開」を行う。
 * 認可・更新・監査・RLS は `setAdvertiserActiveAction` が担保するので、ここは操作と結果表示に徹する。
 *
 * **誤操作防止**: 停止 (論理削除) は不可逆ではないが配信に影響するため共通の `ConfirmDialog` で確認する
 * (`window.confirm` から置換し確認 UI を統一)。再開は確認不要。成功時は成功トーストで明示する。
 */
export function AdvertiserActiveToggle({
  advertiserId,
  isActive,
  companyName,
}: {
  advertiserId: string;
  isActive: boolean;
  companyName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await setAdvertiserActiveAction({ id: advertiserId, isActive: !isActive });
      // 成否いずれもダイアログは閉じる (失敗はインラインの error 表示に集約)。
      setConfirmOpen(false);
      if (res.ok) {
        toast(`「${companyName}」を${isActive ? "停止" : "再開"}しました`, { tone: "success" });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  function onClick() {
    // 停止は確認ダイアログ経由、再開は即実行 (確認不要)。
    if (isActive) {
      setConfirmOpen(true);
    } else {
      run();
    }
  }

  return (
    <span style={wrapStyle}>
      <button type="button" onClick={onClick} disabled={pending} style={btnStyle}>
        {pending ? "…" : isActive ? "停止" : "再開"}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title={`「${companyName}」を停止しますか？`}
        description="配信対象から外れます。"
        confirmLabel="停止する"
        pending={pending}
        onConfirm={run}
        onCancel={() => setConfirmOpen(false)}
      />
    </span>
  );
}

const wrapStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.15rem 0.6rem",
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  fontSize: "0.78rem",
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = { color: "#b91c1c", fontSize: "0.75rem" };
