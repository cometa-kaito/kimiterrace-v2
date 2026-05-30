import { resolveStudentSession } from "../../lib/magic-link/student-session";

/**
 * F05: 生徒ランディング (匿名セッション確立後の着地点)。**Server Component**。
 *
 * `/s/{token}` が cookie を張って redirect してくる。本ページは毎回 cookie を再解決し、
 * 失効/期限切れなら無効メッセージを出す (即時失効。F05「失効後は 410」をページ側でも担保)。
 * 実際のクラスコンテンツ表示 (schedule/notice/assignment + 広告) は #48-E / F06 で実装する。
 * 本ページは「匿名セッションが確立し、再解決が機能する」ことを示す最小着地点。
 *
 * 個人特定情報は一切表示しない (F05)。クラス名等の表示も後続で RLS 下クエリにより追加する。
 */
export default async function StudentLandingPage() {
  const session = await resolveStudentSession();

  if (!session) {
    return (
      <main
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: "32rem",
          margin: "4rem auto",
          padding: "0 1rem",
          textAlign: "center",
        }}
      >
        <h1>セッションが無効です</h1>
        <p>
          アクセス用リンクが失効したか、有効期限が切れています。担任の先生に新しいリンクの発行を
          依頼してください。
        </p>
      </main>
    );
  }

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: "32rem",
        margin: "4rem auto",
        padding: "0 1rem",
        textAlign: "center",
      }}
    >
      <h1>アクセスできました</h1>
      <p>クラスの掲示はまもなくここに表示されます（準備中）。</p>
    </main>
  );
}
