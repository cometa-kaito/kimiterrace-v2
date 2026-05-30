/**
 * F05: 生徒アクセスのクライアントメタ (IP / User-Agent) 抽出 (pure、テスト可能)。
 *
 * F05 受け入れ条件「アクセス元 IP・User-Agent は events に記録 (個人特定はしない、集計用)」。
 * Cloud Run の前段 (Google FE / LB) が `x-forwarded-for` に実クライアント IP を載せる。
 * 値が無い場合は null (記録しないより null 明示)。
 *
 * 注 (PR #160 Reviewer Low-2): `x-forwarded-for` の **先頭要素はクライアント申告値であり
 * スプーフィング可能**。本用途は集計・参考 (個人特定しない) なので許容するが、将来 IP を
 * 不正アクセス調査など信頼を要する用途に使う場合は、信頼できる固定段数の右側プロキシから
 * 数えるか、LB が必ずセットする信頼ヘッダに切り替えること。
 */

export type ClientMeta = {
  ip: string | null;
  userAgent: string | null;
};

/**
 * リクエストヘッダから IP / UA を取り出す。
 *
 * - IP: `x-forwarded-for` の **先頭** (クライアントに最も近い。Cloud Run/LB が追記する)。
 *   無ければ `x-real-ip`。どちらも無ければ null。
 * - UA: `user-agent`。無ければ null。
 */
export function extractClientMeta(headers: Headers): ClientMeta {
  const xff = headers.get("x-forwarded-for");
  let ip: string | null = null;
  if (xff) {
    // "client, proxy1, proxy2" の先頭を採用
    ip = xff.split(",")[0]?.trim() || null;
  } else {
    ip = headers.get("x-real-ip");
  }
  const userAgent = headers.get("user-agent");
  return { ip: ip ?? null, userAgent: userAgent ?? null };
}
