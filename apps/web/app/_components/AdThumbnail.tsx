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

  // mediaUrl は同一オリジン `/ad-media/…`（学校アップロード）か外部 https（運営入稿）。<img>/<video> の
  // `src` は**スクリプトを実行しないシンク**（`javascript:` 等を入れても発火しない・React が属性値をエスケープ）
  // なので XSS 経路にならない。CodeQL js/xss-through-dom はこれを誤検知する（dismiss 済・下の href は
  // safeHttpOrRelative で別途サニタイズ）。詳細は docs/security/codeql-triage-2026-06-18.md。
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

/** 相対パスの同一オリジン判定に使う、現実には存在しない（`.invalid` TLD）プレースホルダ origin。 */
const SAME_ORIGIN_BASE = "https://relative.invalid";

/**
 * http(s) 絶対 URL か **同一オリジン相対パス**（単一 `/` 始まり）だけをリンク先に採用する。
 * `javascript:`/`data:` 等の危険スキームに加え、別オリジンへ飛ぶ**オープンリダイレクト**も弾く:
 * - **プロトコル相対 `//host`**
 * - **`/\host`（先頭スラッシュ直後がバックスラッシュ）**: 一部ブラウザが `\`→`/` 正規化で `//host`
 *   相当（protocol-relative）に解釈する。
 * - **`/<TAB>/host`・`/<LF>/host`・`/<CR>/host`（制御文字）**: ブラウザはパース前に tab/改行/CR を
 *   除去するため `//host` に再正規化されて別オリジンへ飛ぶ。
 *
 * 上記の文字単位ガードを個別に積むのではなく、**相対パスをプレースホルダ origin に解決して origin が
 * 変わらない時だけ採用**する（`new URL` はブラウザと同じ正規化＝tab/改行/CR 除去・特殊スキームでの
 * `\`→`/` 畳み込みを行うので、正規化で別オリジンに化ける入力をクラスごと一括で弾ける）。
 *
 * `SignageClient.safeHttpUrl` と同じ安全側の方針（あちらは相対パスを採らず絶対 http(s) のみなので、
 * この同一オリジン判定は不要＝同種の穴を持たない）。
 */
export function safeHttpOrRelative(url: string): string | null {
  // 1) 絶対 URL は http(s) のみ採用（`javascript:`/`data:`/`file:` 等は弾く）。
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    // 絶対 URL でなければ相対パスとして 2) で判定する。
  }
  // 2) ルート相対パス（単一 `/` 始まり）だけを対象に、プレースホルダ origin へ解決して origin が
  //    変わらない＝同一オリジンに留まる時だけ採用する。`//host`・`/\host` に加え、tab/改行/CR を
  //    挟んで `//host` に再正規化される制御文字オープンリダイレクトもまとめて弾く。
  if (!url.startsWith("/")) {
    return null;
  }
  try {
    return new URL(url, SAME_ORIGIN_BASE).origin === SAME_ORIGIN_BASE ? url : null;
  } catch {
    return null;
  }
}
