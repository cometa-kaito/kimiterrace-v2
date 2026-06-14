import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { formatMaskedJson, truncateText } from "@/lib/system-admin/mask";
import {
  type ContentVersionHistory,
  VERSION_HISTORY_LIMIT,
  getContentVersionHistory,
} from "@/lib/system-admin/publish-history-list";
import { SYSTEM_ADMIN_ROLES } from "@/lib/system-admin/roles";
import { writeViewAccessAudit } from "@/lib/system-admin/view-audit";

const { color, fontSize, space, radius } = tokens;

/** 閲覧監査 INSERT を伴うためキャッシュ禁止 (描画 = 監査 1 行・record_id 付き)。 */
export const dynamic = "force-dynamic";

/**
 * UIUX-03: 1 コンテンツの版履歴 (`/ops/publishes/[contentId]`)。**Server Component**。
 *
 * content_versions (F04.2: 全バージョン保管) を version 降順で時系列表示する。
 * 公開履歴一覧 (`../page.tsx`) からタイトル単位で遷移する詳細ページ。
 *
 * - **認可**: `requireRole(SYSTEM_ADMIN_ROLES)`。可視範囲は RLS に委譲 (クエリ層は検索条件のみ)。
 * - **PII (ルール4)**: snapshot / diff_summary は教員入力由来の自由テキストを含みうるため、
 *   **必ず `formatMaskedJson` / `truncateText` の表示専用変換を通す** (全文は出さない。
 *   全文が必要な調査は DB 直接アクセス + 別途監査の領分)。embedding 列はクエリ層が射影しない。
 * - **閲覧監査 (NFR04 / ルール1)**: 校務コンテンツ (公開物) で PII 性は低いが自由テキストを
 *   含むため、本ページの表示を `writeViewAccessAudit` (subject: "content_versions_view_access"、
 *   recordId: contentId、schoolId: コンテンツの校 id) でデータ取得と**同一 withSession (tx)** 内に
 *   記録する。publish 事実のみの一覧側は記録しない (理由は一覧側の doc 参照)。
 * - DB 到達不能・存在しない id は notFound (ai-chat 詳細 / #740 と同じくエラーバウンダリに
 *   吹き上げない)。
 */
export default async function SystemContentVersionsPage({
  params,
}: {
  params: Promise<{ contentId: string }>;
}) {
  await requireRole(SYSTEM_ADMIN_ROLES);
  const { contentId } = await params;

  const history = await withSession(async (tx, user) => {
    const h = await getContentVersionHistory(tx, contentId);
    if (h) {
      await writeViewAccessAudit(tx, user, {
        subject: "content_versions_view_access",
        schoolId: h.content.schoolId,
        recordId: h.content.id,
        detail: { versionCount: h.totalVersions },
      });
    }
    return h;
  }).catch(() => null);

  if (!history) {
    notFound();
  }
  const { content, versions, totalVersions } = history;

  return (
    <section>
      <p style={backStyle}>
        <Link href="/ops/publishes" style={backLinkStyle}>
          ← 公開履歴一覧へ
        </Link>
      </p>
      <header style={headerStyle}>
        <h1 style={titleStyle}>版履歴</h1>
        <span style={countStyle}>{totalVersions.toLocaleString("ja-JP")} 版</span>
      </header>
      <p style={noteStyle}>
        snapshot・差分要約は表示時マスキング (識別子マスク + 切り詰め) 済みで、全文は表示しません。
        本ページの閲覧は監査ログに記録されました。
      </p>

      <dl style={metaStyle}>
        {/* タイトルは教員入力の自由テキスト — 一覧と同じく切り詰め表示 (mask.ts 規律)。 */}
        <Meta label="コンテンツタイトル" value={truncateText(content.title)} />
        <Meta label="学校" value={content.schoolName} />
        <Meta label="状態" value={STATUS_LABEL[content.status]} />
        <Meta label="コンテンツID" value={content.id} mono />
      </dl>

      {totalVersions > VERSION_HISTORY_LIMIT && (
        <p style={truncNoteStyle}>
          表示は最新 {VERSION_HISTORY_LIMIT} 版まで（全 {totalVersions} 版）。
        </p>
      )}

      <div style={scrollStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th scope="col" style={{ ...thStyle, textAlign: "right" }}>
                版番号
              </th>
              <th scope="col" style={thStyle}>
                作成日時
              </th>
              <th scope="col" style={thStyle}>
                差分要約
              </th>
              <th scope="col" style={thStyle}>
                snapshot（マスク済み要約）
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              // jsonb snapshot は識別子マスク + 文字列切り詰め + ネスト打ち切りの表示専用変換。
              const snapshotText = formatMaskedJson(v.snapshot);
              return (
                <tr key={v.id}>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <strong>v{v.version}</strong>
                  </td>
                  <td style={tdStyle}>
                    <time dateTime={v.createdAt.toISOString()} style={dateStyle}>
                      {formatJstDateTime(v.createdAt)}
                    </time>
                  </td>
                  <td style={tdStyle}>
                    {/* diff_summary は自由テキスト — 切り詰めて表示 (null は未記録)。 */}
                    {v.diffSummary ? (
                      <span style={diffSummaryStyle}>{truncateText(v.diffSummary)}</span>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <code title={snapshotText} style={snapshotStyle}>
                      {snapshotText}
                    </code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** content_status enum の表示ラベル。enum 値を網羅 (型でズレ検出、ルール3)。 */
const STATUS_LABEL: Record<ContentVersionHistory["content"]["status"], string> = {
  draft: "下書き",
  published: "公開",
  archived: "アーカイブ",
};

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={metaItemStyle}>
      <dt style={metaLabelStyle}>{label}</dt>
      <dd style={{ ...metaValueStyle, ...(mono ? { fontFamily: monoFamily } : {}) }}>{value}</dd>
    </div>
  );
}

/** JST の YYYY/MM/DD HH:mm:ss 表示 (サーバー描画、ロケール非依存)。 */
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

const monoFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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
  color: color.muted,
  margin: `0 0 ${space.md}`,
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
const scrollStyle: React.CSSProperties = { overflowX: "auto" };
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%" };
const thStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.muted,
  fontWeight: 600,
  padding: `${space.xs} ${space.sm}`,
  borderBottom: `1px solid ${color.border}`,
  whiteSpace: "nowrap",
  textAlign: "left",
};
const tdStyle: React.CSSProperties = {
  padding: `${space.sm} ${space.sm}`,
  borderBottom: `1px solid ${color.bgSoft}`,
  fontSize: fontSize.md,
  verticalAlign: "top",
};
const dateStyle: React.CSSProperties = { color: color.muted, whiteSpace: "nowrap" };
const mutedStyle: React.CSSProperties = { color: color.muted };
const diffSummaryStyle: React.CSSProperties = {
  display: "block",
  maxWidth: "20rem",
  overflowWrap: "anywhere",
};
const snapshotStyle: React.CSSProperties = {
  display: "block",
  fontFamily: monoFamily,
  fontSize: fontSize.xs,
  color: color.muted,
  maxWidth: "26rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
