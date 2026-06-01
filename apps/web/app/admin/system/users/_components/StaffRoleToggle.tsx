"use client";

import { changeStaffRoleAction } from "@/lib/system-admin/users-actions";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F11 (#47 / #324, ADR-026 D2): system_admin が教職員のロールを **school_admin ↔ teacher** で切り替える
 * トグル。**Client Component** — `/admin/system/users` の各行で操作する。認可・claims 再付与・失効
 * (再ログイン強制)・降格 last-admin ガード・DB mirror・監査は `changeStaffRoleAction` が担保するので、
 * ここは操作と結果表示に徹する (ADR-026: エンフォースは IdP claims)。
 *
 * 教職員ロールは 2 種なのでトグル 1 つで表現する (ボタンラベルは変更先ロール)。ロール変更は **再ログインを
 * 強制する**強い操作のため必ず `window.confirm` で確認する。拒否 (唯一の有効な学校管理者の降格など) は
 * サーバのエラーメッセージを表示する。
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
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const nextRole = currentRole === "school_admin" ? "teacher" : "school_admin";
  const nextRoleLabel = nextRole === "school_admin" ? "学校管理者" : "教員";

  function onClick() {
    if (
      !window.confirm(
        `${schoolName} の「${displayName}」を${nextRoleLabel}に変更します。本人の再ログインが必要になります。よろしいですか？`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await changeStaffRoleAction({ userId, nextRole });
      if (res.ok) {
        router.refresh();
      } else {
        setError(res.error.message);
      }
    });
  }

  return (
    <span style={wrapStyle}>
      <button type="button" onClick={onClick} disabled={pending} style={btnStyle}>
        {pending ? "…" : `${nextRoleLabel}に変更`}
      </button>
      {error ? <output style={errorStyle}>{error}</output> : null}
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
