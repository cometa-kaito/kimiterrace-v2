"use client";

/**
 * グローバルエラーバウンダリ。App Router の特殊ファイル — **ルートレイアウト (app/layout.tsx) 自体**が
 * 描画に失敗した場合のみ発火する最後の砦。ルートレイアウトを置き換えるため `<html>` / `<body>` を
 * 自前で描く必要がある（globals.css も適用されない前提で、文言・スタイルは自己完結させる）。
 * 通常のページ例外は app/error.tsx が捕捉するため、ここに到達するのは稀。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja">
      <body style={bodyStyle}>
        <main style={mainStyle}>
          <h1 style={titleStyle}>問題が発生しました</h1>
          <p style={textStyle}>
            アプリの読み込み中にエラーが発生しました。お手数ですが、もう一度お試しください。
          </p>
          <button type="button" onClick={() => reset()} style={btnStyle}>
            再読み込み
          </button>
          {error.digest ? <p style={digestStyle}>エラー ID: {error.digest}</p> : null}
        </main>
      </body>
    </html>
  );
}

const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Noto Sans JP", Meiryo, sans-serif',
  color: "#1f2937",
  background: "#fff",
};
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
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", margin: 0 };
const textStyle: React.CSSProperties = { color: "#4b5563", maxWidth: "32rem" };
const btnStyle: React.CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.5rem 1.1rem",
  background: "#c2410c",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  fontSize: "0.95rem",
  cursor: "pointer",
};
const digestStyle: React.CSSProperties = {
  marginTop: "0.25rem",
  color: "#9ca3af",
  fontSize: "0.8rem",
};
