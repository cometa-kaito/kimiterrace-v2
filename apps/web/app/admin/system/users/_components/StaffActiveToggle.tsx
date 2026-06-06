"use client";

import { setStaffActiveAction } from "@/lib/system-admin/users-actions";
import { ConfirmDialog, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F11 (#47 / #324): system_admin が全校横断で教職員アカウントを **無効化 / 再有効化** するトグル。
 * **Client Component** — `/admin/system/users` の各行で操作する。認可・IdP 失効・last-admin ガード・
 * DB mirror・監査は `setStaffActiveAction` が担保するので、ここは操作と結果表示に徹する (ADR-026:
 * エンフォースは IdP)。
 *
 * **誤操作防止**: 無効化は「ログイン・操作を即時停止」する強い操作のため共通の `ConfirmDialog`
 * (danger) で確認する (`window.confirm` から置換し、全画面で確認 UI を統一)。再有効化は確認不要。
 * 成功時は成功トースト、拒否 (最後の学校管理者など) はインラインのエラーメッセージを表示する。
 */
export function StaffActiveToggle({
  userId,
  isActive,
  displayName,
  schoolName,
}: {
  userId: string;
  isActive: boolean;
  displayName: string;
  schoolName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await setStaffActiveAction({ userId, isActive: !isActive });
      // 成否いずれもダイアログは閉じる (失敗はインラインの error 表示に集約)。
      setConfirmOpen(false);
      if (res.ok) {
        toast(`${schoolName}「${displayName}」を${isActive ? "無効化" : "再有効化"}しました`, {
          tone: "success",
        });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  function onClick() {
    // 無効化は確認ダイアログ経由、再有効化は即実行 (確認不要)。
    if (isActive) {
      setConfirmOpen(true);
    } else {
      run();
    }
  }

  return (
    <span style={wrapStyle}>
      <button type="button" onClick={onClick} disabled={pending} style={btnStyle}>
        {pending ? "…" : isActive ? "無効化" : "再有効化"}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
      <ConfirmDialog
        open={confirmOpen}
        tone="danger"
        title={`${schoolName} の「${displayName}」を無効化しますか？`}
        description="ログイン・操作が即時停止します。"
        confirmLabel="無効化する"
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
