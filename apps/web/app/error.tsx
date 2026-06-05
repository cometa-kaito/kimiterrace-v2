"use client";

/**
 * ルートエラーバウンダリ。App Router の特殊ファイル — ページ / Server Component の描画中に投げられた
 * 想定外の例外（RLS 拒否・制約違反・一時的な DB 断など）を捕捉する。これが無いと Next 既定の素の
 * 英語「This page couldn't load」全画面（アプリシェルも消える）になるため、/forbidden と同じトーンの
 * 日本語ブランド面に差し替え、再試行 (reset) とホームへの導線を出す（行き止まり防止）。
 *
 * **可観測性**: 元の例外はサーバー側で Next が digest（相関 ID）付きで既にログ出力している。本コンポーネント
 * はクライアントで動くため、ここで重ねてログはせず（PII 露出も避ける、ルール4）、ユーザーには digest を
 * 提示してサーバーログと突き合わせられるようにする。構造化レポート（Sentry, ADR-013）は DSN 投入後に配線。
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main style={mainStyle}>
      <p style={codeStyle}>!</p>
      <h1 style={titleStyle}>問題が発生しました</h1>
      <p style={textStyle}>
        ページの読み込み中にエラーが発生しました。お手数ですが、もう一度お試しください。
        繰り返し発生する場合は、時間をおいて再度アクセスしてください。
      </p>
      <div style={actionsStyle}>
        <button type="button" onClick={() => reset()} style={primaryBtnStyle}>
          再読み込み
        </button>
        {/* 壊れたクライアント状態からも確実に復帰できるよう、ホームは素の <a>（フルリロード）。 */}
        <a href="/admin" style={linkStyle}>
          ホームに戻る
        </a>
      </div>
      {error.digest ? <p style={digestStyle}>エラー ID: {error.digest}</p> : null}
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
  lineHeight: 1,
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", margin: 0 };
const textStyle: React.CSSProperties = { color: "#4b5563", maxWidth: "32rem" };
const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  alignItems: "center",
  marginTop: "0.5rem",
};
const primaryBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1.1rem",
  background: "var(--brand-primary)",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.95rem",
  cursor: "pointer",
};
const linkStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#1f2937",
  color: "#fff",
  borderRadius: "6px",
  textDecoration: "none",
  fontSize: "0.95rem",
};
const digestStyle: React.CSSProperties = {
  marginTop: "0.25rem",
  color: "#9ca3af",
  fontSize: "0.8rem",
};
