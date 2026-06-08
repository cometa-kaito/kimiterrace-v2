import { headers } from "next/headers";

/**
 * 現在のリクエストの **公開オリジン** (`proto://host`) を解決するサーバーユーティリティ。
 *
 * 主用途は「発行したパスワード設定リンクを自校オリジンの `/reset-password` に向ける」(reset-link.ts)。
 * このリンクは **oobCode を載せて第三者 (新規ユーザー) に共有される**ため、宛先 origin が攻撃者に影響され
 * ないことが重要 (PR #730 Reviewer High)。
 *
 * **正準ソース優先**: デプロイで固定する `NEXT_PUBLIC_APP_URL` があればそれを使い、**詐称可能なリクエスト
 * ヘッダ (`x-forwarded-host`) に依存しない**。staging/prod ではビルド引数で注入する (apps/web/Dockerfile)。
 * env 未設定 (ローカル開発・テスト等、脅威モデル外) のときのみヘッダにフォールバックし、その際も host の
 * 形を検証して `evil.com/path` のような注入を弾く。`csrf.ts` はヘッダを「期待値」として **照合**に使うので
 * 安全だが、ここはヘッダを **生成物 (外部共有リンク)** に使うため、verbatim 信頼は避ける (false analogy 回避)。
 *
 * 純粋部分 (`originFromHeaders` / `normalizeConfiguredOrigin`) を分離して node で unit テストする。
 */

/** 設定値 (URL 文字列) を `proto://host` の正準オリジンに正規化する。空 / 解析不能は null。 */
export function normalizeConfiguredOrigin(value: string | undefined | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

// hostname[:port] の形のみ許可。path / userinfo (`@`) / 空白などの混入を弾き、生成リンクへの注入を防ぐ。
const HOST_RE = /^[a-zA-Z0-9.-]+(?::\d+)?$/;

/** Headers から公開オリジン (`proto://host`) を構築する純ロジック。host 不明 / 不正形は null。 */
export function originFromHeaders(h: Headers): string | null {
  // 複数ホップは `, ` 区切りで連なるため先頭 (最も外側の公開値) を採る。
  const host = (h.get("x-forwarded-host") ?? h.get("host"))?.split(",")[0]?.trim();
  if (!host || !HOST_RE.test(host)) {
    return null;
  }
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  return `${proto}://${host}`;
}

/**
 * 現在のリクエストの公開オリジンを返す。正準 `NEXT_PUBLIC_APP_URL` を最優先し、無ければリクエストヘッダ
 * (host 形検証つき) にフォールバックする。リクエストスコープ外 / host 不明・不正は null。
 */
export async function getRequestOrigin(): Promise<string | null> {
  const configured = normalizeConfiguredOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (configured) {
    return configured;
  }
  try {
    return originFromHeaders(await headers());
  } catch {
    return null;
  }
}
