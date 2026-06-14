"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * ログアウトボタン (#48-C)。`POST /api/auth/signout` (cookie 破棄、ADR-003) を叩き、
 * 成否に関わらず `/login` へ遷移する。signout エンドポイントは JSON を返すため、
 * 素の form POST だと生 JSON が表示される — それを避けるためのクライアント遷移。
 */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    setBusy(true);
    try {
      await fetch("/api/auth/signout", { method: "POST" });
    } finally {
      // cookie は削除済 (失敗時もサーバー側で再検証されれば未認証扱い)。ログイン画面へ。
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={busy} style={signoutStyle}>
      {busy ? "..." : "ログアウト"}
    </button>
  );
}

// ヘッダ背景は白 (AppShell headerStyle.background = "#fff")。以前は白文字 + 半透明白枠だったため、
// ブランド刷新でヘッダが白くなった後は "白地に白" で実質不可視になっていた (全ロール・全画面で
// ログアウトが見つからない回帰)。白地で可読な二次ボタン (濃色文字 + 可視枠) にする。
const signoutStyle: React.CSSProperties = {
  background: "#fff",
  color: "#374151",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
  padding: "0.3rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.85rem",
};
