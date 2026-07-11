import { ScaledSignageBoard } from "@/app/(signage)/signage/[classToken]/_components/ScaledSignageBoard";
import { requireRole } from "@/lib/auth/guard";
import { withSession } from "@/lib/db";
import { resolveClassBoardForDate, resolveEditorTargetDate } from "@/lib/editor/board-context";
import { editorPreviewPath, jpDateLabel } from "@/lib/editor/default-date";
import { EDITOR_ROLES } from "@/lib/editor/schedule-core";
import { formatClassIdentity } from "@/lib/signage/class-identity";
import { addDays } from "@/lib/signage/effective-daily-data";
import { jstDateString } from "@/lib/signage/rotation";
import { tokens } from "@kimiterrace/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PreviewDatePicker } from "./_components/PreviewDatePicker";

/**
 * 実寸サイネージプレビュー（#1257）— 教員がスマホ/PC から「実機の TV に出る盤面」を **16:9 の実寸比**で
 * 確認するアプリ内ページ。実機の生 URL（/signage/{token}）はスマホ（≤899px）で 1 列縦積みのモバイル
 * レイアウトに崩れ、`?date=` もポーリングが今日で上書きするため別日確認ができない——その代替。
 *
 * 盤面はエディタ page.tsx と**同じ共有ヘルパ**（board-context.ts＝実機と同一の `buildSignagePayloadForClass`・
 * 端末別パターン解決・エディタと同じ既定対象日）で組み、{@link ScaledSignageBoard}（1280×720 固定ステージ +
 * 16:9 縮小・read-only 静的描画＝ポーリング/時計/広告ローテーション無し）で画面幅いっぱいに描く。認可も
 * エディタと同一（`/app` layout + EDITOR_ROLES・別テナントは RLS 不可視 → 404）。日付は `?date=YYYY-MM-DD`
 * （前日/翌日リンク + date ピッカーで切替）。
 */
export default async function SignagePreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireRole(EDITOR_ROLES);
  const { classId } = await params;
  const { date: dateParam } = await searchParams;
  const now = new Date();
  const today = jstDateString(now);

  const data = await withSession(async (tx) => {
    // 対象日 → 盤面の組み立てはエディタと同じ共有ヘルパ（合成・パターン解決をここで再実装しない・#1257）。
    const { date, displaySettings } = await resolveEditorTargetDate(tx, dateParam, now);
    const { board, liveSignageUrl } = await resolveClassBoardForDate(
      tx,
      classId,
      user.schoolId,
      date,
      displaySettings,
    );
    return { date, board, liveSignageUrl };
  });
  const { date, board, liveSignageUrl } = data;
  // クラスが自校で不可視（別テナント / 存在しない）なら payload が null → 404（エディタと同じ規律）。
  if (!board) {
    notFound();
  }
  const identity = formatClassIdentity(board.classContext);

  return (
    <>
      {/* パンくず（エディタページと同じ視覚言語: 小さく薄く・主役は盤面）。編集中だった日付へ戻す。 */}
      <nav aria-label="パンくず" style={breadcrumbRowStyle}>
        <Link href={`/app/editor/${classId}?date=${date}`} style={breadcrumbBackStyle}>
          <span aria-hidden="true">‹</span> エディタに戻る
        </Link>
        <span aria-hidden="true" style={breadcrumbSepStyle}>
          ／
        </span>
        <h1 style={titleStyle}>{identity ? `${identity} ` : ""}サイネージプレビュー</h1>
      </nav>

      {/* 日付ナビ: 土日も飛ばさず 1 日ずつ送る（休日の盤面＝空も「実機にそう出る」確認対象のため）。 */}
      <nav aria-label="表示する日付" style={dateNavStyle}>
        <Link href={editorPreviewPath(classId, addDays(date, -1))} style={dateNavLinkStyle}>
          ‹ 前日
        </Link>
        <PreviewDatePicker classId={classId} date={date} />
        <Link href={editorPreviewPath(classId, addDays(date, 1))} style={dateNavLinkStyle}>
          翌日 ›
        </Link>
        <span style={dateLabelStyle}>
          {jpDateLabel(date)}
          {date === today ? "（今日）" : ""}の盤面
        </span>
      </nav>

      {/* ScaledSignageBoard は width 未指定＝container query で枠幅（画面幅いっぱい）に自動フィット。 */}
      <div style={boardFrameStyle}>
        <ScaledSignageBoard payload={board} />
      </div>

      {board.blackout ? (
        <p style={noteStyle}>
          現在このモニタは「黒画面」設定中です（実機は黒画面・プレビューは盤面データを表示しています）。
        </p>
      ) : null}
      {liveSignageUrl ? (
        <p style={noteStyle}>
          <a
            href={liveSignageUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: tokens.color.muted }}
          >
            実機の画面を開く ↗
          </a>
        </p>
      ) : null}
    </>
  );
}

// 以下スタイルはエディタ page.tsx と同じ視覚言語・トークン値（新規の色・独自スタイルを増やさない）。
const breadcrumbRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  marginBottom: "0.5rem",
  flexWrap: "wrap",
};
const breadcrumbBackStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.15rem",
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  textDecoration: "none",
};
const breadcrumbSepStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.border,
};
const titleStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.neutralFg,
  margin: 0,
};
const dateNavStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
  margin: "0 0 0.75rem",
};
// ナビゲーション（見る）なので選択・ナビ系のブランド青（#1241 の役割分離・エディタのリンクと同じ）。
const dateNavLinkStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.primaryHover,
  textDecoration: "none",
};
const dateLabelStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: 600,
  color: tokens.color.ink,
};
// 盤面枠: 16:9 比率は ScaledSignageBoard の .frame が確保。枠線 + 角丸だけの控えめ装飾。
const boardFrameStyle: React.CSSProperties = {
  width: "100%",
  border: `1px solid ${tokens.color.border}`,
  borderRadius: 12,
  overflow: "hidden",
};
const noteStyle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.muted,
  margin: "0.6rem 0 0",
};
