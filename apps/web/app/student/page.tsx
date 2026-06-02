import { resolveStudentSession } from "../../lib/magic-link/student-session";
import { StudentChat } from "./_components/StudentChat";

/**
 * F05/F06: 生徒ランディング (匿名セッション確立後の着地点)。**Server Component**。
 *
 * `/s/{token}` が cookie を張って redirect してくる。本ページは毎回 cookie を再解決し、
 * 失効/期限切れなら無効メッセージを出す (即時失効。F05「失効後は 410」をページ側でも担保)。
 * セッションが有効なら **F06 掲示物 Q&A チャット ({@link StudentChat}) をマウント**する。
 *
 * **トークン秘匿 (F05/F06, ルール5)**: 本 Server Component は `StudentChat` に **トークンを渡さない**。
 * チャットは `/api/student/chat` が httpOnly cookie `__student_session` をサーバ側で再解決する経路で、
 * 生 magic link は URL/JS/ログに一切出ない。ページ側の `resolveStudentSession` 判定はクライアントへ
 * UI を出すか否かの最適化で、認可の最終防衛線は route の再解決 (即時失効) + RLS (自校スコープ)。
 *
 * 個人特定情報は一切表示しない (F05)。クラス名等の表示も後続で RLS 下クエリにより追加する。
 *
 * 失効時のステータス契約 (PR #160 Reviewer Medium-1): F05「失効後は 410」の権威ある入口は
 * `/s/{token}` (route.ts が 410)。本ランディングへの再訪での失効は **HTTP 200 + 無効メッセージ**
 * とする (Server Component から 410 を返す標準手段が無く、コンテンツ非表示で漏洩は無いため)。
 * 即時失効の本体は「毎回再解決して null ならコンテンツを出さない」であり、ここで担保される。
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
        maxWidth: "40rem",
        margin: "2rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>クラスの掲示について質問できます</h1>
      <p>
        掲示物に関する質問を入力すると、AI が答えます。学習や進路の相談には対応していません。
        日時・持ち物など掲示に無い詳細は先生に確認してください。
      </p>
      <StudentChat />
    </main>
  );
}
