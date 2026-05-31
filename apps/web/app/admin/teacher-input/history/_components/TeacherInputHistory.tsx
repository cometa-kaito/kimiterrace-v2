/**
 * F02 (#38, FR-08): 教員入力の履歴一覧 (presentational, 副作用なし)。
 *
 * server page から RLS スコープ済みの行を ISO 文字列 + 表示用に正規化して受け取り、表示するだけ。
 * 認可・取得は page (server) が担う。transcript は PII を含みうるが、閲覧者は自校の staff
 * (teacher / school_admin) に限定済みで、ここでは抜粋のみ表示する (LLM には渡さない = ルール4)。
 */

/** ライフサイクル状態の表示ラベル (teacher_input_status enum と 1:1)。 */
const STATUS_LABEL = {
  draft: "下書き",
  transcribing: "文字起こし中",
  ready: "準備完了",
  submitted: "送信済み",
} as const;

const STATUS_COLOR = {
  draft: "#6b7280",
  transcribing: "#b45309",
  ready: "#2563eb",
  submitted: "#15803d",
} as const;

const TYPE_LABEL = {
  voice: "音声",
  chat: "チャット",
} as const;

export type TeacherInputHistoryRow = {
  id: string;
  inputType: keyof typeof TYPE_LABEL;
  status: keyof typeof STATUS_LABEL;
  /** 本文の抜粋 (page 側で truncate 済み)。未入力は空文字。 */
  transcriptPreview: string;
  createdAt: string;
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

export function TeacherInputHistory({ rows }: { rows: TeacherInputHistoryRow[] }) {
  if (rows.length === 0) {
    return <p style={{ color: "#6b7280", fontSize: "0.9rem" }}>まだ入力履歴はありません。</p>;
  }

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {rows.map((row) => (
        <li
          key={row.id}
          style={{
            padding: "0.6rem 0",
            borderTop: "1px solid #e5e7eb",
            fontSize: "0.9rem",
          }}
        >
          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                color: "#fff",
                background: STATUS_COLOR[row.status],
                borderRadius: "0.25rem",
                padding: "0.1rem 0.45rem",
              }}
            >
              {STATUS_LABEL[row.status]}
            </span>
            <span style={{ color: "#6b7280" }}>{TYPE_LABEL[row.inputType]}</span>
            <span style={{ color: "#9ca3af", marginLeft: "auto" }}>
              {formatDate(row.createdAt)}
            </span>
          </div>
          <p style={{ margin: "0.35rem 0 0", color: "#374151", whiteSpace: "pre-wrap" }}>
            {row.transcriptPreview || <span style={{ color: "#9ca3af" }}>（本文なし）</span>}
          </p>
        </li>
      ))}
    </ul>
  );
}
