import type { CSSProperties } from "react";

/**
 * 広告メディアの**サムネイル表示**（画像/動画を実物でグラフィカルに確認するための共通部品）。
 *
 * これまで `mediaUrl` をテキスト/リンクで出していた箇所（学校エディタ AdsManager・運営広告 CRM
 * `/ops/advertisers`・サイネージプレビュー SignageBoard）を、実際の画像/動画で確認できるようにする。
 *
 * - image: `<img>` をそのまま描く。同一オリジン `/ad-media/…`（学校アップロード）も外部 https（運営入稿）も
 *   どちらも `src` に渡せる（本番サイネージ＝`SignageClient` の `<img src={ad.mediaUrl}>` と同作法）。
 * - video: 先頭フレームのみ出す（`preload="metadata"` の muted `<video>`）。一覧で多数が自動再生して
 *   重くならないよう `autoPlay`/`loop` は付けない（原寸再生はクリックで別タブに委ねる）。
 * - クリックで原寸を別タブに開く（`mediaUrl` が http(s) か同一オリジン相対のときだけ `<a>` 化。
 *   `javascript:`/`data:` 等は弾く＝XSS/オープンリダイレクト防止・SignageClient の safeHttpUrl と同方針）。
 * - `mediaUrl` 欠落は灰色プレースホルダー（一覧/盤面を壊さない fail-soft）。
 *
 * state/effect を持たない純表示部品なので Server / Client どちらのツリーからも使える（`"use client"` 不要）。
 */
export function AdThumbnail({
  mediaUrl,
  mediaType,
  caption,
  size = 80,
  linkToFull = true,
}: {
  mediaUrl: string | null | undefined;
  mediaType: "image" | "video";
  caption?: string | null;
  /** サムネイルの一辺（px、既定 80）。 */
  size?: number;
  /** クリックで原寸を別タブに開くか（既定 true）。 */
  linkToFull?: boolean;
}) {
  const box: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: 6,
    overflow: "hidden",
    background: "#f3f4f6",
    border: "1px solid #e5e7eb",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  };
  const media: CSSProperties = { width: "100%", height: "100%", objectFit: "contain" };

  if (!mediaUrl) {
    return (
      <span style={{ ...box, color: "#9ca3af", fontSize: "0.7rem" }} aria-label="素材なし">
        なし
      </span>
    );
  }

  const inner =
    mediaType === "video" ? (
      <>
        {/* 先頭フレームのみ（autoPlay/loop なし・controls 無しで非フォーカス）。装飾プレビューで accessible name は
            持たせず、意味は親 <a> の aria-label が担保する。 */}
        <video src={mediaUrl} muted playsInline preload="metadata" style={media} />
        <span style={playBadgeStyle} aria-hidden="true">
          ▶
        </span>
      </>
    ) : (
      // 外部 CDN / 同一オリジン両対応のため next/image は使わず素の <img>（signage と同作法）。
      // eslint-disable-next-line @next/next/no-img-element
      <img src={mediaUrl} alt={caption ?? "広告素材"} style={media} loading="lazy" />
    );

  const href = linkToFull ? safeHttpOrRelative(mediaUrl) : null;
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={box}
        aria-label={caption ? `広告素材を開く: ${caption}` : "広告素材を開く"}
      >
        {inner}
      </a>
    );
  }
  return <span style={box}>{inner}</span>;
}

const playBadgeStyle: CSSProperties = {
  position: "absolute",
  bottom: 2,
  right: 2,
  fontSize: "0.7rem",
  lineHeight: 1,
  padding: "0.1rem 0.25rem",
  borderRadius: 4,
  background: "rgba(0,0,0,0.55)",
  color: "#fff",
};

/**
 * http(s) 絶対 URL か **同一オリジン相対パス**（単一 `/` 始まり）だけをリンク先に採用する。
 * `javascript:`/`data:` 等の危険スキームに加え、**プロトコル相対 `//host`**（別オリジンへ飛ぶ
 * オープンリダイレクト）も弾く（`SignageClient.safeHttpUrl` と同じ安全側の方針）。
 */
function safeHttpOrRelative(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) {
    return url;
  }
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
