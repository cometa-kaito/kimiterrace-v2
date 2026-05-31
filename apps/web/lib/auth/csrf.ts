/**
 * 認証系 state-changing POST (login / signout) への CSRF 防御 (#139 L2、ADR-003 / NFR03)。
 *
 * **このモジュールはサーバー専用** (Route Handler から Request を受け取り判定する)。
 *
 * ## なぜ sameSite=lax だけに頼らないか (多層防御)
 *
 * session cookie は `sameSite=lax` で発行しており、クロスサイトの POST ではブラウザがそもそも
 * cookie を送らない。しかしこれだけに依存しないのは:
 * - **login CSRF**: `POST /api/auth/session` は cookie に依存せず body の `idToken` だけで
 *   session を発行する。攻撃者ページが自分の idToken を被害者ブラウザから POST させると、
 *   被害者を「攻撃者のアカウント」にログインさせられる (login CSRF)。sameSite=lax は
 *   ambient cookie を守るだけで、この経路 (cookie 非依存) は塞がない。
 * - ブラウザ実装差・将来のポリシー変更に対する保険 (深層防御、CLAUDE.md「迷ったら安全側」)。
 *
 * ## 判定方式: Origin (無ければ Referer) のホスト突合
 *
 * ブラウザ起点のクロスサイト POST には **必ず `Origin` が載る** (同一オリジン POST にも載る)。
 * よって「`Origin`/`Referer` が在れば到達ホストと厳密に突合・両方無ければ通す」とすると:
 * - login CSRF (攻撃者ページが idToken を POST) → `Origin`=攻撃元ホスト で mismatch → 拒否
 * - signout CSRF → sameSite=lax で cookie 自体が送られない + `Origin` mismatch で二重に拒否
 * - 非ブラウザ API クライアント (Playwright APIRequestContext / server-to-server) は
 *   `Origin`/`Referer` を持たず、そもそも ambient-cookie CSRF の媒介にならないため通す
 *   (= e2e の `POST /api/auth/session` を壊さない)
 * を同時に満たす。
 *
 * `Host` ヘッダ自体の詐称は CSRF の媒介にならない: 被害者ブラウザは `Origin` を偽れず
 * (常に実オリジンを載せる)、攻撃者が直接リクエストを組む経路には被害者の ambient cookie が
 * 無いため。したがって「到達ホスト (`x-forwarded-host` → `host`) と `Origin` ホストの一致」で十分。
 *
 * @see app/api/auth/session/route.ts (login) / app/api/auth/signout/route.ts (logout)
 */

/**
 * ヘッダ値 (Origin / Referer) からホスト部 (`host[:port]`) を取り出す。
 * パースできない値は null (= 判定材料にしない)。
 */
function headerHost(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * リクエストが同一オリジン (= CSRF でない) と見なせるか。
 *
 * - 到達ホスト = `x-forwarded-host` (Cloud Run/GCLB が公開ホストを載せる) を優先、無ければ `host`。
 *   到達ホストが判定できなければ突合不能なので **false (deny、安全側)**。通常 `host` は必ず在る。
 * - **`Origin` ヘッダが在れば必ず一致を要求**する: ホスト一致のみ true、別ホスト・unparseable・
 *   `"null"` (sandboxed iframe / opaque origin) はすべて **false**。Referer へはフォールスルーしない
 *   (Origin が在るのにパースできない/合わない = ブラウザ起点の不正とみなす。`Origin: null` を
 *   突いた login CSRF 回避を塞ぐ、deny-by-default)。
 * - `Origin` ヘッダが**無い時だけ** `Referer` のホストで判定する (古い/一部クライアント保険)。
 * - どちらのヘッダも無ければ非ブラウザクライアント (ブラウザ起点 CSRF はここに到達しない) として **true**。
 *
 * スキームは比較しない (TLS 終端 LB の背後で `x-forwarded-proto` と Origin scheme がずれうるため、
 * ホスト一致で十分 — Next.js の Server Action CSRF 判定と同じ思想)。
 */
export function isSameOriginRequest(request: Request): boolean {
  const expectedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!expectedHost) {
    return false;
  }

  // Origin ヘッダが「存在する」なら (空文字含め) ブラウザ起点とみなし、必ず一致を要求する。
  // unparseable / "null" は headerHost が null を返し expectedHost と一致しないため deny に倒れる。
  const origin = request.headers.get("origin");
  if (origin !== null) {
    return headerHost(origin) === expectedHost;
  }

  // Origin が無い時のみ Referer で判定 (フォールバック)。
  const referer = request.headers.get("referer");
  if (referer !== null) {
    return headerHost(referer) === expectedHost;
  }

  // Origin も Referer も無い = 非ブラウザクライアント。ブラウザ起点 CSRF は必ず Origin を載せるため
  // ここには到達しない。非ブラウザは ambient cookie CSRF の対象でもないので通す。
  return true;
}
