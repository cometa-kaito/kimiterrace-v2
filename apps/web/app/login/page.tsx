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
 * 教員ロールが最多のため **教員ログイン（学校共通パスワード）を中心**に設計する（ユーザー要望）。本サーバー
 * コンポーネントは「共通ログインが有効な学校」を列挙して `LoginForm`（Client）へ渡す:
 *  - 1 校のみ有効 → 学校選択を出さず「パスワードのみ」。
 *  - 複数校 → 学校選択を出す。
 *  - 0 校 → 教員モードは出さず職員ログインを既定にする。
 *
 * 学校解決は `listTeacherLoginSchools(getDb())`（RLS の扉、内部で system_admin 文脈、ADR-032）。公開
 * （未認証）経路だが返すのは有効校の id/名のみ（秘密なし）。DB 障害時も**職員ログインは使えるべき**なので
 * 失敗は握りつぶして空配列にフォールバックする（教員モードが出ないだけ）。
 *
 * `LoginForm` は `useSearchParams`（next）を使うため Suspense 境界で包む（Next のビルド要件）。
 */
export default async function LoginPage(): Promise<React.ReactElement> {
  let teacherSchools: { id: string; name: string }[] = [];
  try {
    teacherSchools = await listTeacherLoginSchools(getDb());
  } catch {
    // DB 障害でも職員ログインは出す（教員モードのみ抑止）。理由はログに出さない（ルール5）。
    teacherSchools = [];
  }

  return (
    <Suspense fallback={null}>
      <LoginForm next="/admin" teacherSchools={teacherSchools} />
    </Suspense>
  );
}
