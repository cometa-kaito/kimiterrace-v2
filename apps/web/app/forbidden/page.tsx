import Link from "next/link";

/**
 * 403 (権限不足) ハンドリング UI (#48-C)。
 *
 * 認証は済んでいるが当該リソースへの role が無い場合に `requireRole` がここへ redirect する。
 * 401 (未認証) は `/login` 側で扱う — 本ページは「ログイン済みだが見せられない」状態専用。
 *
 * **情報露出を避ける (NFR04 Information Disclosure)**: どのリソースで弾かれたか・必要な role は
 * 明示しない。一般的な文言に留め、攻撃者に権限境界の地図を与えない。
 */
export default function ForbiddenPage() {
  return (
    <main style={mainStyle}>
      <p style={codeStyle}>403</p>
      <h1 style={titleStyle}>アクセス権限がありません</h1>
      <p style={textStyle}>
        このページを表示する権限がありません。権限が必要な場合は学校管理者にお問い合わせください。
      </p>
      <Link href="/app" style={linkStyle}>
        ホームに戻る
      </Link>
    </main>
  );
}

const mainStyle: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  padding: "2rem",
  textAlign: "center",
};

const codeStyle: React.CSSProperties = {
  fontSize: "3rem",
  fontWeight: 800,
  color: "#9ca3af",
  margin: 0,
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", margin: 0 };
const textStyle: React.CSSProperties = { color: "#4b5563", maxWidth: "32rem" };
const linkStyle: React.CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.5rem 1rem",
  background: "#1f2937",
  color: "#fff",
  borderRadius: "6px",
  textDecoration: "none",
};
