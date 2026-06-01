"use client";

import { setMemberActiveAction } from "@/lib/role-management/member-actions";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * F11 (#47 / #324): 教職員のアカウント **無効化 / 再有効化** トグル。**Client Component** — 教職員一覧の
 * 各行 (管理可の対象) で操作する。認可・IdP 失効・DB mirror・監査は `setMemberActiveAction` が担保するので、
 * ここは操作と結果表示に徹する (ADR-026: エンフォースは IdP、本コンポーネントは UI)。
 *
 * **誤操作防止**: 無効化は「ログイン・操作を即時停止」する強い操作のため `window.confirm` で確認する。
 * 再有効化は確認不要。
 */
export function MemberActiveToggle({
  userId,
  isActive,
  displayName,
}: {
  userId: string;
  isActive: boolean;
  displayName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (
      isActive &&
      !window.confirm(
        `「${displayName}」を無効化します。ログイン・操作が即時停止します。よろしいですか？`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setMemberActiveAction({ userId, isActive: !isActive });
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
        {pending ? "…" : isActive ? "無効化" : "再有効化"}
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
