import Link from "next/link";

/**
 * 404 (Not Found) ハンドリング UI。Next.js App Router の特殊ファイル — 未一致ルートや
 * `notFound()` 呼出で描画される。これが無いと Next 既定の素の英語ページ（"This page could not be
 * found." / アプリシェルも消える）になるため、/forbidden と同じトーンの日本語ブランド面に差し替え、
 * ホームへの導線を出して行き止まりを防ぐ。
 */
export default function NotFound() {
  return (
    <main style={mainStyle}>
      <p style={codeStyle}>404</p>
      <h1 style={titleStyle}>ページが見つかりません</h1>
      <p style={textStyle}>
        お探しのページは存在しないか、移動または削除された可能性があります。URL
        をご確認のうえ、ホームからやり直してください。
      </p>
      <Link href="/admin" style={linkStyle}>
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
