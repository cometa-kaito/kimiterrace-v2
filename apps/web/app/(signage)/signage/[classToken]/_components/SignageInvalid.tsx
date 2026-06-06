/**
 * 無効/失効トークン時の全画面表示 (#48-E2)。個人特定情報は一切出さない (threat-model S-03)。
 * Server Component (初期描画) でも Client Island (ポーリングで 410 検知) でも使う純粋表示。
 */
export function SignageInvalid() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 2rem",
        gap: "1rem",
      }}
    >
      <h1 style={{ fontSize: "2rem", margin: 0, color: "#111827" }}>表示できません</h1>
      <p style={{ fontSize: "1.1rem", color: "#6b7280", margin: 0 }}>
        この表示リンクは失効したか、有効期限が切れています。
        <br />
        担任の先生に新しいリンクの発行を依頼してください。
      </p>
    </div>
  );
}
