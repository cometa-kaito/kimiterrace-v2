import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { SESSION_MESSAGES_LIMIT, getAiChatSessionDetail } from "@/lib/system-admin/ai-chat-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { writeViewAccessAudit } from "@/lib/system-admin/view-audit";

const { color, fontSize, space, radius } = tokens;

/** 閲覧監査 INSERT を伴うためキャッシュ禁止（描画 = 監査 1 行・record_id 付き）。 */
export const dynamic = "force-dynamic";

/**
 * UIUX-03 PR4: ai_chat セッション詳細（対話の時系列表示）。⚠ PII 最重要
 * （docs/compliance/admin-viewer-policy.md DRAFT 準拠）:
 * - 本文は保存時マスク済み（{{STUDENT_001}} 等のトークンがそのまま見えるのが正常状態）。
 *   **逆変換は実装しない**。
 * - **どのセッションを見たかを record_id 付きで audit_log に記録**する。
 * - DB 到達不能・存在しない id は notFound（#740 と同じくエラーバウンダリに吹き上げない）。
 */
export default async function SystemAiChatSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { id } = await params;

  const detail = await withSession(async (tx, user) => {
    const d = await getAiChatSessionDetail(tx, id);
    if (d) {
      await writeViewAccessAudit(tx, user, {
        subject: "ai_chat_view_access",
        schoolId: d.session.schoolId,
        recordId: d.session.id,
        detail: { messageCount: d.totalMessages },
      });
    }
    return d;
  }).catch(() => null);

  if (!detail) {
    notFound();
  }
  const { session, messages, totalMessages } = detail;

  return (
    <section>
      <p style={backStyle}>
        <Link href="/admin/system/ai-chat" style={backLinkStyle}>
          ← セッション一覧へ
        </Link>
      </p>
      <header style={headerStyle}>
        <h1 style={titleStyle}>対話セッション詳細</h1>
        <span style={countStyle}>{totalMessages} 発話</span>
      </header>
      <p style={noteStyle}>
        本文は保存時に PII マスキング済み（{"{{STUDENT_001}}"}
        等のトークン表示が正常）。逆変換はできません。本閲覧は監査ログに記録されました。
      </p>

      <dl style={metaStyle}>
        <Meta label="学校" value={session.schoolName} />
        <Meta label="経路" value={session.route === "student" ? "生徒（匿名）" : "教員"} />
        <Meta label="クラス" value={session.className ?? "—"} />
        <Meta label="開始" value={formatJstDateTime(session.startedAt)} />
        <Meta label="最終発話" value={formatJstDateTime(session.lastMessageAt)} />
        <Meta label="状態" value={session.closedAt ? "終了" : "進行中"} />
        <Meta label="セッションID" value={session.id} mono />
      </dl>

      {totalMessages > SESSION_MESSAGES_LIMIT && (
        <p style={truncNoteStyle}>
          表示は先頭 {SESSION_MESSAGES_LIMIT} 発話まで（全 {totalMessages} 発話）。
        </p>
      )}

      <ol style={threadStyle}>
        {messages.map((m) => (
          <li
            key={m.id}
            style={{
              ...bubbleStyle,
              ...(m.role === "user" ? userBubbleStyle : {}),
              ...(m.role === "system" ? systemBubbleStyle : {}),
            }}
          >
            <div style={bubbleHeadStyle}>
              <strong>{ROLE_LABEL[m.role] ?? m.role}</strong>
              <span style={bubbleMetaStyle}>
                {formatJstDateTime(m.createdAt)}
                {m.modelVersion ? ` ・ ${m.modelVersion}` : ""}
                {m.confidenceScore !== null ? ` ・ 確信度 ${m.confidenceScore.toFixed(2)}` : ""}
                {` ・ ${m.tokenCount} tokens`}
              </span>
            </div>
            <div style={bubbleBodyStyle}>{m.contentText}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** role 表示ラベル（varchar 列のため未知値は生値 fallback）。 */
const ROLE_LABEL: Record<string, string> = {
  user: "質問（user）",
  assistant: "AI 応答（assistant）",
  system: "システム（system）",
};

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={metaItemStyle}>
      <dt style={metaLabelStyle}>{label}</dt>
      <dd style={{ ...metaValueStyle, ...(mono ? { fontFamily: "monospace" } : {}) }}>{value}</dd>
    </div>
  );
}

/** JST の YYYY/MM/DD HH:mm:ss 表示（ロケール非依存に固定）。 */
function formatJstDateTime(value: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

const backStyle: React.CSSProperties = { marginBottom: space.sm };
const backLinkStyle: React.CSSProperties = { color: color.primary, fontSize: fontSize.sm };
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: space.sm,
};
const titleStyle: React.CSSProperties = { fontSize: "1.3rem", fontWeight: 700 };
const countStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.muted };
const noteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.warningFg,
  background: color.warningBg,
  border: `1px solid ${color.warningBorder}`,
  borderRadius: radius.sm,
  padding: `${space.sm} ${space.md}`,
  marginBottom: space.lg,
};
const metaStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: space.lg,
  margin: `0 0 ${space.lg}`,
  padding: space.md,
  background: color.bgSoft,
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
};
const metaItemStyle: React.CSSProperties = { minWidth: "8rem" };
const metaLabelStyle: React.CSSProperties = { fontSize: fontSize.xs, color: color.muted };
const metaValueStyle: React.CSSProperties = { fontSize: fontSize.sm, margin: 0 };
const truncNoteStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.warningFg,
  marginBottom: space.md,
};
const threadStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: space.md,
};
const bubbleStyle: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  padding: `${space.sm} ${space.md}`,
  background: "#fff",
  maxWidth: "52rem",
};
const userBubbleStyle: React.CSSProperties = {
  background: color.infoBg,
  borderColor: color.infoBorder,
};
const systemBubbleStyle: React.CSSProperties = {
  background: color.neutralBg,
  color: color.muted,
};
const bubbleHeadStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: space.md,
  fontSize: fontSize.xs,
  color: color.muted,
  marginBottom: space.xs,
};
const bubbleMetaStyle: React.CSSProperties = { whiteSpace: "nowrap" };
const bubbleBodyStyle: React.CSSProperties = {
  fontSize: fontSize.md,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
