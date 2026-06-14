import { requireRole } from "@/lib/auth/guard";
import { PUBLISHER_ROLES, type PublishScopeValue } from "@/lib/contents/publish-core";
import { scopeLabel } from "@/lib/contents/publish-view";
import { withSession } from "@/lib/db";
import { getContentConfidence, getContentDetail } from "@kimiterrace/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfidenceBadge } from "../_components/ConfidenceBadge";
import { ContentStatusBadge } from "../_components/ContentStatusBadge";
import { PublishControls } from "../_components/PublishControls";
import { VersionTimeline } from "../_components/VersionTimeline";

/**
 * F04: コンテンツ詳細 + 安全網 (`/app/contents/[id]`)。**Server Component**。
 *
 * **認可 (#166)**: 一覧と同じく `requireRole(PUBLISHER_ROLES)` (school_admin / teacher) に限定。
 * system_admin は cross-tenant 全件可視 (system_admin_full_access policy) のため自校公開フロー用の
 * 本画面では 403 に倒す (一覧 `page.tsx` の認可ノート参照、本 Issue 方針 A)。
 *
 * `getContentDetail` (PR #156) で本体 + バージョン履歴 + 公開状態を RLS 込みで取得し、
 * - 即公開 / 非公開 (`PublishControls`)
 * - 1-click rollback タイムライン (`VersionTimeline`、F04.2)
 * - 公開状態バッジ / 確信度フラグ (F04.3)
 * を 1 画面に集約する。不可視 (別テナント / 不存在) は `notFound()` (RLS が null を返す)。
 */
export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(PUBLISHER_ROLES);
  const { id } = await params;
  // 同一トランザクション (RLS context) で本体 + 確信度を取得する。
  const { detail, confidence } = await withSession(async (tx) => {
    const d = await getContentDetail(tx, id);
    return { detail: d, confidence: d ? await getContentConfidence(tx, id) : null };
  });
  if (!detail) {
    notFound();
  }
  const { content, versions, activePublish } = detail;

  return (
    <article style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <Link href="/app/contents" style={backLinkStyle}>
        ← コンテンツ一覧
      </Link>

      <header style={headerStyle}>
        <h1 style={titleStyle}>{content.title}</h1>
        <span style={metaStyle}>
          <ContentStatusBadge status={content.status} />
          <span style={scopeStyle}>
            公開先: {scopeLabel(content.publishScope as PublishScopeValue)}
          </span>
        </span>
      </header>

      {/* F04.3 確信度フラグ。最も確信度の低い AI 抽出 (ai_extractions, ADR-017) を表示。
          抽出が無い (人手作成) なら ConfidenceBadge は何も描画しない。 */}
      <ConfidenceBadge score={confidence?.score} evidence={confidence?.evidence ?? undefined} />

      <PublishControls contentId={content.id} status={content.status} />

      <section style={bodyCardStyle}>
        <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{content.body || "（本文なし）"}</p>
      </section>

      <section>
        <h2 style={sectionTitleStyle}>バージョン履歴</h2>
        <VersionTimeline
          contentId={content.id}
          versions={versions}
          activeVersionId={activePublish?.versionId ?? null}
        />
      </section>
    </article>
  );
}

const backLinkStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  color: "#2563eb",
  textDecoration: "none",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};
const titleStyle: React.CSSProperties = { fontSize: "1.4rem", fontWeight: 700, margin: 0 };
const metaStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem" };
const scopeStyle: React.CSSProperties = { fontSize: "0.85rem", color: "#6b7280" };
const bodyCardStyle: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  padding: "1rem",
  background: "#fafafa",
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  marginBottom: "0.6rem",
};
