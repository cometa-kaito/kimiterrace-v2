/**
 * F12 (#48-M): フィードバックのガイド画面 `/guide` (**非認証 / 公開**)。
 *
 * 教員・見学者など誰でもログインせずにフィードバックを送れる受付フォーム (V1 feedback 受付の移植)。
 * middleware で `/guide` は `__session` ゲートから除外済。素の HTML `<form>` で JS 無しでも動作し、
 * `POST /api/guide/feedback` (Route Handler) に送る。投稿は SECURITY DEFINER `submit_feedback`
 * 経由で 1 行 INSERT され、閲覧は system_admin のみ (system_admin_only RLS) なので匿名公開でも
 * フィードバック内容 (PII を含みうる) は漏れない。
 *
 * **PII 注意 (ルール4)**: 「具体的なエピソード」欄は生徒名等を含みうる。保存のみで LLM には
 * 渡さない旨を packages/db schema/feedback.ts に明記済。フォーム文言でも個人名の記入を不要とする。
 *
 * Server Component。送信後は PRG で `/guide?submitted=1` に戻り、完了メッセージを出す。
 */
export default async function GuidePage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string }>;
}) {
  const { submitted } = await searchParams;
  const isSubmitted = submitted === "1";

  return (
    <main style={mainStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>キミテラス フィードバック</h1>
        <p style={leadStyle}>
          ご利用ありがとうございます。サービス改善のため、率直なご意見をお聞かせください。
          ログインは不要です。
        </p>
      </header>

      {isSubmitted ? (
        <output style={thanksStyle}>
          <p style={{ fontWeight: 700, marginBottom: "0.25rem" }}>送信しました。</p>
          <p>
            貴重なご意見をありがとうございました。続けて送る場合は下のフォームをご利用ください。
          </p>
        </output>
      ) : null}

      <form method="post" action="/api/guide/feedback" style={formStyle}>
        <label style={labelStyle}>
          学校名
          <input
            type="text"
            name="schoolName"
            maxLength={200}
            placeholder="例: 岐南工業高等学校"
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          教室・クラス
          <input
            type="text"
            name="classroomLabel"
            maxLength={200}
            placeholder="例: 1-A"
            style={inputStyle}
          />
        </label>

        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>生徒の反応・注目度 (必須)</legend>
          <ScoreRadios name="studentReaction" />
        </fieldset>

        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>先生の業務負担・利便性 (必須)</legend>
          <ScoreRadios name="teacherUtility" />
        </fieldset>

        <label style={labelStyle}>
          生徒の反応についての具体的なエピソード
          <span style={hintStyle}>※ 個人が特定される氏名などの記入は不要です。</span>
          <textarea name="studentEpisode" maxLength={4000} rows={4} style={textareaStyle} />
        </label>

        <label style={labelStyle}>
          改善のご要望・お気付きの点
          <textarea name="improvement" maxLength={4000} rows={4} style={textareaStyle} />
        </label>

        <button type="submit" style={submitStyle}>
          送信する
        </button>
      </form>
    </main>
  );
}

/** 1〜5 のラジオ (低い=1 / 高い=5)。必須属性で未選択送信を防ぐ (DB CHECK と二重防御)。 */
function ScoreRadios({ name }: { name: string }) {
  return (
    <div style={radioRowStyle}>
      <span style={scaleEndStyle}>低い</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} style={radioLabelStyle}>
          <input type="radio" name={name} value={n} required />
          <span>{n}</span>
        </label>
      ))}
      <span style={scaleEndStyle}>高い</span>
    </div>
  );
}

const mainStyle: React.CSSProperties = {
  maxWidth: "40rem",
  margin: "0 auto",
  padding: "2rem 1rem 4rem",
  fontFamily: "system-ui, sans-serif",
  color: "#111827",
};
const headerStyle: React.CSSProperties = { marginBottom: "1.5rem" };
const titleStyle: React.CSSProperties = { fontSize: "1.5rem", fontWeight: 800 };
const leadStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.9rem",
  marginTop: "0.5rem",
  lineHeight: 1.6,
};
const thanksStyle: React.CSSProperties = {
  display: "block",
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
  borderRadius: "0.5rem",
  padding: "0.9rem 1rem",
  marginBottom: "1.5rem",
  color: "#065f46",
  fontSize: "0.9rem",
};
const formStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "1.2rem" };
const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  fontSize: "0.9rem",
  fontWeight: 600,
};
const hintStyle: React.CSSProperties = { color: "#9ca3af", fontSize: "0.78rem", fontWeight: 400 };
const inputStyle: React.CSSProperties = {
  padding: "0.55rem 0.7rem",
  border: "1px solid #d1d5db",
  borderRadius: "0.4rem",
  fontSize: "0.95rem",
};
const textareaStyle: React.CSSProperties = { ...inputStyle, resize: "vertical" };
const fieldsetStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  padding: "0.75rem 1rem",
};
const legendStyle: React.CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 600,
  padding: "0 0.4rem",
};
const radioRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
};
const radioLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "0.2rem",
  fontWeight: 400,
};
const scaleEndStyle: React.CSSProperties = { color: "#9ca3af", fontSize: "0.8rem" };
const submitStyle: React.CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.7rem 1rem",
  background: "#1d4ed8",
  color: "#fff",
  border: "none",
  borderRadius: "0.5rem",
  fontSize: "1rem",
  fontWeight: 700,
  cursor: "pointer",
};
