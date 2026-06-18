/**
 * ADR-045 §SSRF 緩和: 管理者が登録する **任意の公開 iCal/ICS URL** を、weather Job（egress=ALL_TRAFFIC で
 * VPC 内・Cloud SQL プライベート IP / GCP メタデータ 169.254.169.254 に到達可能）から取得するための
 * **SSRF セーフな HTTP 取得ユーティリティ**。
 *
 * 攻撃面（なぜ要るか）:
 * - weather Job は VPC コネクタ経由 egress=ALL_TRAFFIC で動き、Cloud SQL プライベート IP（10/8 等）・
 *   GCP メタデータサーバ（169.254.169.254 → SA トークン窃取）・他内部サービスに **到達できる**。
 * - `ics_url` は school_admin（将来の設定 UI）が登録する **半信頼の外部入力**。素の fetch だと
 *   `http://169.254.169.254/...` や `http://10.0.0.5/` を入れられて **ブラインド SSRF** になりうる。
 *
 * 防御（多層・すべて fail-soft = 違反は throw し、呼び出し側 run.ts が当該校だけ skip して他校・天気系を継続）:
 *  1. **scheme は https のみ**許可（http/file/ftp/data 等は拒否）。
 *  2. **ホスト検証**: IP リテラルはそのまま、ホスト名は DNS 解決（A/AAAA 全件）し **解決された全 IP** を検査。
 *     プライベート/予約レンジを 1 つでも含めば拒否（部分的に内部へ向く DNS への保険）。localhost/.internal/
 *     metadata.google.internal 等の **ホスト名**も明示拒否。
 *  3. **リダイレクト安全**: `redirect:"manual"` で自前処理。各ホップの Location を **再度 scheme+IP 検証**して
 *     から次へ進む（公開ホストから内部 IP への 30x リダイレクト攻撃を塞ぐ）。最大 `maxRedirects`（既定 3）。
 *  4. **レスポンスサイズ上限** `maxBytes`（既定 5MB）。ストリームで読み、超過は中断・拒否（巨大 body DoS 回避）。
 *  5. **認証情報を送らない**（cookie/credentials 無し）、明示 User-Agent、`AbortController` で timeout。
 *  6. **依存注入**: DNS resolver / fetch を注入できる（既定は実体）ので、ネットワーク無しで単体検証できる。
 *
 * ## ★ 残存リスク: DNS リバインディング（TOCTOU）
 * 本実装は「DNS 解決 → IP 検査 → fetch」だが、検査時に解決した IP と fetch 時に OS が再解決する IP が
 * **ズレうる**（攻撃者が短い TTL で公開 IP → 内部 IP に差し替える DNS リバインディング）。完全に塞ぐには
 * **検証済み IP への接続ピンニング**（custom dispatcher / lookup で IP を固定）が要るが、本 PR スコープ外とする。
 * 現状は (a) https 限定で MITM を難しくし、(b) リダイレクト各ホップを再検証し、(c) 解決全 IP を検査することで
 * 実務上の主要面（直接内部 URL・リダイレクト誘導・部分内部 DNS）を塞ぐ。IP ピンニングは follow-up
 * （ADR-045 §残存リスク⑥）。
 */

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/** DNS 解決の依存注入インタフェース（`dns/promises` lookup の all:true 互換のサブセット）。 */
export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** 既定の resolver: `dns/promises` lookup を all:true で叩き A/AAAA 全件を返す。 */
const defaultResolver: DnsResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

/** `fetchPublicIcs` の任意オプション（テスト容易性のため fetch / resolver を注入できる）。 */
export interface SafeFetchOptions {
  /** タイムアウト（ms）。既定 10s。 */
  timeoutMs?: number;
  /** 明示 User-Agent（外部に礼儀正しく）。 */
  userAgent: string;
  /** レスポンスサイズ上限（bytes）。既定 5MB。超過は中断・拒否。 */
  maxBytes?: number;
  /** 追従するリダイレクトの最大数。既定 3。 */
  maxRedirects?: number;
  /** Accept ヘッダ。既定は iCal 向け。 */
  accept?: string;
  /** テスト差し替え用の fetch 実装（既定は global fetch）。 */
  fetchImpl?: typeof fetch;
  /** テスト差し替え用の DNS resolver（既定は dns/promises lookup, all:true）。 */
  resolver?: DnsResolver;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_ACCEPT = "text/calendar,text/plain";

/** SSRF 検証に失敗したとき投げる専用エラー（呼び出し側はメッセージに生 URL を載せない）。 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/**
 * 拒否すべきホスト名（完全一致 / サフィックス一致）。DNS 解決前の **名前ベース**の保険。
 * - `localhost` / `*.localhost`（RFC 6761、ループバックに解決される慣習）
 * - `*.internal`（GCP/AWS 内部 DNS の慣習サフィックス）
 * - `metadata.google.internal`（GCP メタデータ。169.254.169.254 のエイリアス）
 */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""); // 末尾ドット（FQDN 表記）を除去
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "internal" || h.endsWith(".internal")) return true;
  if (h === "metadata.google.internal") return true;
  if (h === "metadata") return true;
  return false;
}

/** ドット区切り IPv4 文字列を 32bit 符号なし整数にする（妥当な v4 でなければ null）。 */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i]);
    if (octet < 0 || octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** `addr` が CIDR（base/prefix、いずれも IPv4）に属するか。 */
function ipv4InCidr(addr: number, baseIp: string, prefix: number): boolean {
  const base = ipv4ToInt(baseIp);
  if (base == null) return false;
  if (prefix <= 0) return true;
  const mask = prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (addr & mask) >>> 0 === (base & mask) >>> 0;
}

/**
 * IPv4 文字列がプライベート/予約/特殊レンジ（= 外部公開先として拒否すべき）か判定する。
 * 仕様（ADR-045 §SSRF）: 0/8, 10/8, 100.64/10(CGNAT), 127/8, 169.254/16(メタデータ含む), 172.16/12,
 * 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255。
 */
function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n == null) return true; // パース不能な v4 は安全側に倒して拒否
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8], // "this" network
    ["10.0.0.0", 8], // private
    ["100.64.0.0", 10], // CGNAT
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local（GCP/AWS メタデータ 169.254.169.254 を含む）
    ["172.16.0.0", 12], // private
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.168.0.0", 16], // private
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved（255.255.255.255 を含む）
  ];
  for (const [base, prefix] of blocked) {
    if (ipv4InCidr(n, base, prefix)) return true;
  }
  return false;
}

/** IPv6 アドレスを 8 個の 16bit ハウストグループに正規化する（`::` 省略を展開）。妥当でなければ null。 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.trim();
  // ゾーン ID（fe80::1%eth0 の %... 以降）を落とす。
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (s.length === 0) return null;

  // IPv4-mapped/embedded（末尾が a.b.c.d）の v4 部分を 2 グループへ変換。
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : s;
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 == null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    s = `${s.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const doubleColon = s.indexOf("::");
  let groups: string[];
  if (doubleColon >= 0) {
    // "::" の前後を分け、欠けたグループを 0 で埋める。
    if (s.indexOf("::", doubleColon + 1) >= 0) return null; // "::" は 1 回のみ
    const head = s.slice(0, doubleColon);
    const rest = s.slice(doubleColon + 2);
    const headParts = head.length > 0 ? head.split(":") : [];
    const restParts = rest.length > 0 ? rest.split(":") : [];
    const missing = 8 - (headParts.length + restParts.length);
    if (missing < 0) return null;
    groups = [...headParts, ...Array(missing).fill("0"), ...restParts];
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

/**
 * IPv6 文字列がプライベート/予約/特殊レンジ（拒否すべき）か判定する。
 * 仕様: ::1（loopback）, ::（unspecified）, ::ffff:0:0/96（IPv4-mapped → 内側 v4 を再検査）,
 * fc00::/7（ULA）, fe80::/10（link-local。::ffff:169.254.x 等のメタデータ系も IPv4-mapped 経由で再検査）。
 */
function isBlockedIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (g == null) return true; // パース不能は安全側に倒して拒否
  // ::（unspecified, 全 0）
  if (g.every((x) => x === 0)) return true;
  // ::1（loopback）
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  // ::ffff:0:0/96（IPv4-mapped）: 先頭 5 group が 0、6 番目が 0xffff → 内側 v4 を再検査。
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v4 = `${(g[6] ?? 0) >> 8}.${(g[6] ?? 0) & 0xff}.${(g[7] ?? 0) >> 8}.${(g[7] ?? 0) & 0xff}`;
    return isBlockedIpv4(v4);
  }
  // fc00::/7（ULA）: 先頭バイトの上位 7bit が 1111110。
  const firstByte = (g[0] ?? 0) >> 8;
  if ((firstByte & 0xfe) === 0xfc) return true;
  // fe80::/10（link-local）: 先頭 10bit が 1111111010。
  if ((g[0] ?? 0) >= 0xfe80 && (g[0] ?? 0) <= 0xfebf) return true;
  return false;
}

/**
 * IP リテラル文字列がプライベート/予約レンジに属する（= 外部公開先として拒否すべき）か。
 * IPv4 / IPv6 を `node:net` の `isIP` で判別して各判定へ振り分ける。判別不能は安全側で拒否。
 */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true; // IP として解釈できないものは安全側で拒否
}

/**
 * 1 つの URL を検証し、(scheme=https) かつ (host が安全な公開先) であることを確認する。
 * - scheme が https でなければ拒否。
 * - host が拒否ホスト名（localhost/.internal/metadata.google.internal 等）なら拒否。
 * - host が IP リテラルなら直接 IP 判定。ホスト名なら DNS 解決し **全 IP** を判定（1 つでも内部なら拒否）。
 * 検証 NG は `SsrfBlockedError` を throw（メッセージに生ホスト/URL は載せない）。
 */
export async function assertSafeUrl(rawUrl: string, resolver: DnsResolver): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("不正な URL（パース不能）");
  }
  if (url.protocol !== "https:") {
    throw new SsrfBlockedError(`許可されない scheme（https のみ）: ${url.protocol}`);
  }
  // URL.hostname は IPv6 リテラルを角括弧付きで返す（"[::1]"）。角括弧を外して IP 判定に回す。
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) {
    throw new SsrfBlockedError("ホストが空");
  }
  if (isBlockedHostname(host)) {
    throw new SsrfBlockedError("拒否ホスト名（loopback / internal / metadata）");
  }
  // IP リテラルか？（角括弧 IPv6 は URL.hostname が外してくれる）
  const fam = isIP(host);
  if (fam !== 0) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError("プライベート/予約 IP リテラルは拒否");
    }
    return;
  }
  // ホスト名 → DNS 解決して全 IP を検査（1 つでも内部レンジを含めば拒否）。
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await resolver(host);
  } catch {
    throw new SsrfBlockedError("DNS 解決に失敗（取得を中止）");
  }
  if (addrs.length === 0) {
    throw new SsrfBlockedError("DNS 解決結果が空（取得を中止）");
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfBlockedError("解決された IP がプライベート/予約レンジを含む");
    }
  }
}

/** `Response` body をストリームで読み、`maxBytes` 超過なら中断して `SsrfBlockedError` を投げる。 */
async function readTextWithLimit(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) {
    // body ストリームが無い（テスト Response 等）。text() でまとめて読みサイズだけ後検査する。
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new SsrfBlockedError(`レスポンスがサイズ上限を超過（>${maxBytes}B）`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // 上限超過: 読み取りを中断（残りを捨てる）して拒否。
          await reader.cancel().catch(() => {});
          throw new SsrfBlockedError(`レスポンスがサイズ上限を超過（>${maxBytes}B）`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * SSRF セーフに公開 https URL を GET し、本文テキストを返す。リダイレクトは自前で各ホップ再検証して追従する。
 *
 * - 認証情報は送らない（cookie/credentials 無し、`redirect:"manual"`）。
 * - 各ホップ前に `assertSafeUrl`（scheme=https + 公開 IP）を必ず通す。
 * - 30x は `maxRedirects` まで。Location 欠落 / 解決不能 / 検証 NG は拒否。
 * - 2xx 以外（30x 超過・4xx・5xx）は throw。
 * - レスポンスは `maxBytes` までで打ち切り（超過は拒否）。
 * - 全体に `AbortController` の timeout。
 *
 * すべての拒否は throw（fail-soft）。呼び出し側（run.ts のカレンダーフェーズ）が当該校だけ skip する。
 */
export async function fetchPublicIcs(url: string, options: SafeFetchOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolver = options.resolver ?? defaultResolver;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? (options.timeoutMs as number)
    : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? (options.maxBytes as number)
    : DEFAULT_MAX_BYTES;
  const maxRedirects = Number.isFinite(options.maxRedirects)
    ? (options.maxRedirects as number)
    : DEFAULT_MAX_REDIRECTS;
  const accept = options.accept ?? DEFAULT_ACCEPT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      // ★ 各ホップで scheme + 解決 IP を再検証してから fetch（リダイレクトで内部へ飛ぶ攻撃を塞ぐ）。
      await assertSafeUrl(current, resolver);
      const res = await fetchImpl(current, {
        method: "GET",
        headers: { "User-Agent": options.userAgent, Accept: accept },
        // 認証情報を送らない / リダイレクトは自前処理。
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
      });
      const status = res.status;
      if (status >= 300 && status < 400) {
        // リダイレクト: Location を解決して次ホップへ（再検証は次ループ先頭で行う）。
        const location = res.headers.get("location");
        // body を読み切らずに捨てる（リーク回避）。
        await res.body?.cancel().catch(() => {});
        if (!location) {
          throw new SsrfBlockedError("リダイレクトに Location が無い");
        }
        if (hop >= maxRedirects) {
          throw new SsrfBlockedError(`リダイレクト上限超過（>${maxRedirects}）`);
        }
        // 相対 Location を現在 URL 基準で絶対化（次ループ先頭で assertSafeUrl が再検証する）。
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`取得失敗: status=${status}`);
      }
      return await readTextWithLimit(res, maxBytes);
    }
    // ループを抜けた = リダイレクト上限（理論上 throw 済みだが保険）。
    throw new SsrfBlockedError(`リダイレクト上限超過（>${maxRedirects}）`);
  } finally {
    clearTimeout(timer);
  }
}
