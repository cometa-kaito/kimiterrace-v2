import { jstDateString } from "@/lib/signage/rotation";
import { getSignageDisplayData } from "@/lib/signage/signage-display";
import { SignageClient } from "./_components/SignageClient";
import { SignageInvalid } from "./_components/SignageInvalid";

/**
 * 公開サイネージ表示ページ `/signage/{classToken}` (#48-E / F12、V1 root `/` の移植)。
 *
 * **Server Component (初期描画)** + **Client Island (再生制御)** の境界:
 *   - 本ページ: token を解決し RLS 下で初期データ (時間割/連絡/課題 + 実効広告) を 1 度取得し、
 *     `SignageClient` に初期値として渡す。初回ロードを高速化 (NFR01「サイネージ画面ロード < 1.5 秒」)。
 *   - `SignageClient`: 以降の広告ローテーションと 5-10 秒ポーリング自動更新を担う (#48-E2)。
 *     onSnapshot の置換 (ADR-022 pull 型)。
 *
 * **認証なし・匿名公開**: テナント分離は token→`withTenantContext` で DB レベル強制 (ルール2、
 * `signage-display.ts` 参照)。無効/失効トークンは静的な無効画面を出す (Server Component から 410 を
 * 返す標準手段が無いため 200 + 無効表示。F05 `/student` と同方針。コンテンツは一切出さないので漏洩なし)。
 * ポーリング側 (data Route Handler) は 410 を返し、クライアントは失効を検知して無効表示へ倒す。
 *
 * **middleware 依存 (要 #48-B 連携)**: `/signage/` は現状 `apps/web/middleware.ts` の matcher 除外に
 * 含まれず、`__session` 無しで `/login` にリダイレクトされる。公開到達には matcher の negative
 * lookahead に `signage` を追加する必要がある (本スライスは middleware を所掌外として触らない。PR 説明参照)。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// token + RLS スコープのため静的化しない (毎リクエスト解決。失効を即時反映)。
export const dynamic = "force-dynamic";

export default async function SignagePage({
  params,
  searchParams,
}: {
  params: Promise<{ classToken: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { classToken } = await params;
  const { date: dateParam } = await searchParams;

  // 既定は JST の今日。?date=YYYY-MM-DD で任意日を表示可 (形式不正は無視して今日)。
  const date = dateParam && DATE_RE.test(dateParam) ? dateParam : jstDateString();

  const payload = await getSignageDisplayData(classToken, date);
  if (!payload) {
    return <SignageInvalid />;
  }

  return <SignageClient classToken={classToken} initial={payload} />;
}
