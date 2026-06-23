import { listTeacherLoginSchools } from "@kimiterrace/db";
import { Suspense } from "react";
import { getDb } from "../../lib/db";
import { LoginForm } from "./_components/LoginForm";

/**
 * **動的レンダリング必須**（force-dynamic）。本ページは「共通ログインが有効な学校」を毎リクエスト DB から
 * 引いて教員モードの出し分けを決める。指定が無いと Next は public ページの本ルートを**静的プリレンダ**して
 * `s-maxage` で長期キャッシュするため、ビルド時点（有効校 0）の HTML が凍結配信され、後から system_admin が
 * 学校の共通パスワードを設定（`teacher_login_enabled=true`）しても**教員ログイン UI が現れない**バグになる
 * （prod で実発生: `x-nextjs-prerender:1` / `s-maxage=31536000`）。有効化を即時反映するため動的に固定する。
 */
export const dynamic = "force-dynamic";

/**
 * ログイン画面 (ADR-003 / ADR-032)。**Server Component**。
 *
 * 教員ロールが最多のため **教員ログイン（学校共通パスワード）を中心**に設計する（ユーザー要望）。教員は
 * 学校を選ばず**パスワードのみ**を入力し、サーバーが入力パスワードで学校を自動判定する（ADR-032 追補）。
 * 本サーバーコンポーネントは「共通ログインが有効な学校が 1 校以上あるか」だけを判定し、教員モードを出すか
 * （= 有効校あり → 教員ログインを既定表示 / 0 校 → 職員ログインを既定）を `LoginForm` に渡す。
 *
 * 学校解決は `listTeacherLoginSchools(getDb())`（RLS の扉、内部で system_admin 文脈、ADR-032）。公開
 * （未認証）経路だが、クライアントへ渡すのは**有無の真偽値のみ**（学校 id/名は出さない）。DB 障害時も
 * **職員ログインは使えるべき**なので失敗は握りつぶして「教員モードなし」にフォールバックする。
 *
 * `LoginForm` は `useSearchParams`（next）を使うため Suspense 境界で包む（Next のビルド要件）。
 */
export default async function LoginPage(): Promise<React.ReactElement> {
  let teacherLoginAvailable = false;
  try {
    teacherLoginAvailable = (await listTeacherLoginSchools(getDb())).length > 0;
  } catch {
    // DB 障害でも職員ログインは出す（教員モードのみ抑止）。理由はログに出さない（ルール5）。
    teacherLoginAvailable = false;
  }

  return (
    <Suspense fallback={null}>
      <LoginForm next="/app" teacherLoginAvailable={teacherLoginAvailable} />
    </Suspense>
  );
}
