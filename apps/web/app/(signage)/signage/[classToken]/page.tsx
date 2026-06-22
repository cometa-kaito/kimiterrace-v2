import { headers } from "next/headers";
import { shouldApplyFitStage } from "@/lib/signage/fit-mode";
import { parseSignageDate } from "@/lib/signage/rotation";
import { getSignageDisplayData } from "@/lib/signage/signage-display";
import { SignageClient } from "./_components/SignageClient";
import { SignageInvalid } from "./_components/SignageInvalid";
import styles from "./_components/signage.module.css";

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
 * **middleware 除外済 (PR #192)**: `/signage/` は `apps/web/middleware.ts` の matcher negative
 * lookahead で除外済 (`signage/`)。端末は `__session` を持たない匿名公開経路としてゲート対象外で、
 * `/login` には弾かれない。可否は token 解決が判定する (上記「認証なし・匿名公開」参照)。
 */

// token + RLS スコープのため静的化しない (毎リクエスト解決。失効を即時反映)。
export const dynamic = "force-dynamic";

export default async function SignagePage({
  params,
  searchParams,
}: {
  params: Promise<{ classToken: string }>;
  searchParams: Promise<{ date?: string; design?: string; fit?: string | string[] }>;
}) {
  const { classToken } = await params;
  const { date: dateParam, design, fit } = await searchParams;

  // 既定は JST の今日。?date=YYYY-MM-DD で任意日を表示可 (形式不正・無効暦日は今日へフォールバック)。
  const date = parseSignageDate(dateParam);

  // ?design=patternN は端末別デザイン（TV の signage_url が持つ）。未指定/未知は学校レベル既定→pattern1。
  const payload = await getSignageDisplayData(classToken, date, design);
  if (!payload) {
    return <SignageInvalid />;
  }

  const board = (
    <SignageClient basePath={`/signage/${encodeURIComponent(classToken)}`} initial={payload} />
  );

  // **実機サイネージ端末（tv-ble-bridge の Android WebView）は盤面を画面いっぱいに描く**べきなので fit-stage を
  // 当てない。判定は `?fit=on/off` 明示が最優先、未指定は UA で自動（端末＝全画面 / PC・タブレットの実ブラウザ＝縮小）。
  // fit-mode.ts 単一ソース。端末で UA 判定が外れた場合の安全弁は signage_url に `?fit=off` を付けること。
  const ua = (await headers()).get("user-agent");
  if (!shouldApplyFitStage(fit, ua)) {
    return board;
  }

  // タブレット/PC（≥900px）では盤面を「実機モニタ（16:9・1920×1080）の忠実な縮小コピー」として見せる
  // （signage.module.css §14）。3 つのラッパは ≤899px では display:contents で消えるため、スマホの縦スクロール
  // 挙動は従来どおり不変。再生制御（ポーリング/時計/ローテ）は内側の SignageClient がそのまま担う（ライブ）。
  return (
    <div className={styles.fitViewport}>
      <div className={styles.fitStageSizer}>
        <div className={styles.fitStage}>{board}</div>
      </div>
    </div>
  );
}
