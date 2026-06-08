import { headers } from "next/headers";

/**
 * 現在のリクエストの **公開オリジン** (`proto://host`) を解決するサーバーユーティリティ。
 *
 * Cloud Run / GCLB は公開ホストを `x-forwarded-host`、スキームを `x-forwarded-proto` に載せる
 * (内部 host は `*.run.app`)。csrf.ts の到達ホスト判定と同方針で `x-forwarded-host` → `host` の順で見る。
 * 主用途は「発行したパスワード設定リンクを自校オリジンの `/reset-password` に向ける」(reset-link.ts)。
 *
 * **純粋部分を分離** (`originFromHeaders`) して node で unit テストし、`getRequestOrigin` は `headers()` を
 * 読むだけの薄いラッパにする。リクエストスコープ外で呼ばれた場合 (`headers()` が throw) は **null** を返し、
 * 呼出側が安全側にフォールバックできるようにする (発行を壊さない)。
 */

/** Headers から公開オリジン (`proto://host`) を構築する純ロジック。host 不明なら null。 */
export function originFromHeaders(h: Headers): string | null {
  // 複数ホップは `, ` 区切りで連なるため先頭 (最も外側の公開値) を採る。
  const host = (h.get("x-forwarded-host") ?? h.get("host"))?.split(",")[0]?.trim();
  if (!host) {
    return null;
  }
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  return `${proto}://${host}`;
}

/** 現在のリクエストの公開オリジンを返す。リクエストスコープ外 / host 不明は null。 */
export async function getRequestOrigin(): Promise<string | null> {
  try {
    return originFromHeaders(await headers());
  } catch {
    return null;
  }
}
