"use client";

import { changeStaffRoleAction } from "@/lib/system-admin/users-actions";
import { ConfirmDialog, useToast } from "@kimiterrace/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F11 (#47 / #324, ADR-026 D2): system_admin が教職員のロールを **school_admin ↔ teacher** で切り替える
 * トグル。**Client Component** — `/admin/system/users` の各行で操作する。認可・claims 再付与・失効
 * (再ログイン強制)・降格 last-admin ガード・DB mirror・監査は `changeStaffRoleAction` が担保するので、
 * ここは操作と結果表示に徹する (ADR-026: エンフォースは IdP claims)。
 *
 * 教職員ロールは 2 種なのでトグル 1 つで表現する (ボタンラベルは変更先ロール)。ロール変更は **再ログインを
 * 強制する**強い操作のため必ず共通の `ConfirmDialog` で確認する (`window.confirm` から置換し確認 UI を統一)。
 * 成功時は成功トースト、拒否 (唯一の有効な学校管理者の降格など) はインラインのエラーメッセージを表示する。
 */
export function StaffRoleToggle({
  userId,
  currentRole,
  displayName,
  schoolName,
}: {
  userId: string;
  currentRole: "school_admin" | "teacher";
  displayName: string;
  schoolName: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const nextRole = currentRole === "school_admin" ? "teacher" : "school_admin";
  const nextRoleLabel = nextRole === "school_admin" ? "学校管理者" : "教員";

  function run() {
    setError(null);
    startTransition(async () => {
      const res = await changeStaffRoleAction({ userId, nextRole });
      // 成否いずれもダイアログは閉じる (失敗はインラインの error 表示に集約)。
      setConfirmOpen(false);
      if (res.ok) {
        toast(`${schoolName}「${displayName}」を${nextRoleLabel}に変更しました`, {
          tone: "success",
        });
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <span style={wrapStyle}>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
        style={btnStyle}
      >
        {pending ? "…" : `${nextRoleLabel}に変更`}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
      <ConfirmDialog
        open={confirmOpen}
        tone="primary"
        title={`${schoolName} の「${displayName}」を${nextRoleLabel}に変更しますか？`}
        description="本人の再ログインが必要になります。"
        confirmLabel="変更する"
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
