/**
 * F15 / F05 (ADR-022 / ADR-019): 岐阜県立岐南工業高等学校「電子工学科 1〜3 年」の各クラスに
 * **サイネージ表示用の magic link** を発行し、対応する `tv_devices.signage_url` を
 * `https://app.school-signage.net/signage/<token>` に設定するための **純ロジック（副作用なし）**。
 * 実投入は {@link ./seed-ginan-signage-cli.ts} が行う（DB 接続・tx・RLS context は CLI 側）。
 *
 * ## なぜ専用 seed なのか（cutover の文脈）
 * 実機 TV cutover では、各 TV が webview で表示する URL（v1 = `app.school-signage.net/?school=…&class=…`、
 * v2 = `app.school-signage.net/signage/<token>`）を v2 形へ差し替える必要がある。v2 のサイネージ表示は
 * クラス単位の magic link（{@link ../../apps/web/lib/magic-link/token.ts} と同方式のトークン）で個別化される
 * ため、各クラスにリンクを発行し、その plaintext トークンを `signage_url` に焼き込む。トークンは
 * **DB に直接書き込み**、人手・ログには出さない（[[project_provision_system_admin_procedure]] と同じ秘匿規律）。
 *
 * ## 県教委 Wi-Fi 制約（docs/discovery/wifi-filter-method.md）
 * 実機 TV が表示 URL に到達できるのは FQDN 許可リスト上 `app.school-signage.net` のみ（`.run.app` は遮断）。
 * ゆえに base は既定で `https://app.school-signage.net`（env `SIGNAGE_BASE_URL` で上書き可・検証用）。
 *
 * ## トークン方式（apps/web/lib/magic-link/token.ts と同一）
 * `generateToken` = 32 byte 乱数 → base64url（約 43 文字）。`hashToken` = SHA-256 hex（64 文字）を DB に保存。
 * plaintext は signage_url にのみ載り、DB の magic_links には hash しか残さない（ルール5）。
 *
 * ## TTL（重要・サイネージは長寿命）
 * 生徒個別リンクの既定は 90 日だが、サイネージ（kiosk）は常時表示ゆえ短い失効は**画面が突然消える事故**になる。
 * よって既定 TTL を 3650 日（10 年）とし、env `SEED_GINAN_SIGNAGE_TTL_DAYS` で上書き可能にする。
 * トークンはクラス掲示物の匿名 read のみを許可し PII を含まない（F05）ため長寿命でも露出は最小。
 */

import { createHash, randomBytes } from "node:crypto";
import { GINAN_ECE_DEPARTMENT_NAME, GINAN_SCHOOL_NAME } from "./seed-ginan-tv-devices.js";

/** 解決キー定数は TV seed と共有（同じ学校・学科）。再 export して参照を一元化。 */
export { GINAN_SCHOOL_NAME, GINAN_ECE_DEPARTMENT_NAME };

/** 対象学年（電子工学科 1〜3 年）。 */
export const GINAN_SIGNAGE_GRADES: readonly [1, 2, 3] = [1, 2, 3];

/** サイネージ表示 URL の既定 base（県教委 Wi-Fi 許可 FQDN）。 */
export const DEFAULT_SIGNAGE_BASE_URL = "https://app.school-signage.net";

/** magic link の既定 TTL（日）。サイネージは長寿命ゆえ 10 年（生徒個別リンクの 90 日とは別運用）。 */
export const DEFAULT_SIGNAGE_TTL_DAYS = 3650;

/**
 * サイネージ表示 magic link トークンを生成する（apps/web の generateToken と同方式）。
 * 32 byte 乱数 → base64url（URL/QR セーフ・約 43 文字）。**plaintext は signage_url にのみ載せ、DB には hash**。
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** トークンを SHA-256 hex（64 文字）にハッシュする（apps/web の hashToken と同方式）。DB には hash のみ保存。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * 末尾の連続スラッシュを除去する（二重スラッシュ正規化）。**正規表現 `/\/+$/` は使わない**: アンカー無しの
 * `\/+$` は「多数のスラッシュ + 非スラッシュ」入力で O(n^2) の polynomial-redos になる（CodeQL
 * js/polynomial-redos）。本実装は末尾から線形に走査する（ReDoS 不能）。
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * base + token から v2 サイネージ表示 URL（`<base>/signage/<token>`）を組み立てる。
 * base 末尾のスラッシュは正規化する（二重スラッシュ防止）。
 */
export function buildSignageUrl(base: string, token: string): string {
  const trimmed = stripTrailingSlashes(base);
  return `${trimmed}/signage/${token}`;
}

/**
 * env から base URL を解決する（未指定/空なら既定 `app.school-signage.net`）。末尾スラッシュ正規化済み。
 * http(s) スキーム以外は拒否（fail-fast）。
 */
export function resolveSignageBaseUrl(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  const base = v.length === 0 ? DEFAULT_SIGNAGE_BASE_URL : v;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`[seed-ginan-signage] SIGNAGE_BASE_URL is not a valid URL: ${base}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`[seed-ginan-signage] SIGNAGE_BASE_URL must be http(s): ${base}`);
  }
  return stripTrailingSlashes(base);
}

/**
 * env から TTL（日）を解決する（未指定なら既定 3650 日）。正の整数でなければ fail-fast。
 */
export function resolveSignageTtlDays(raw: string | undefined): number {
  const v = (raw ?? "").trim();
  if (v.length === 0) {
    return DEFAULT_SIGNAGE_TTL_DAYS;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `[seed-ginan-signage] SEED_GINAN_SIGNAGE_TTL_DAYS must be a positive integer: ${raw}`,
    );
  }
  return n;
}

/**
 * 既存 signage_url が「v2 サイネージ（同 base 配下の /signage/）」として既に設定済みかを判定する。
 * 設定済みなら CLI は当該クラスをスキップしトークンを churn しない（冪等）。
 */
export function isV2SignageUrl(signageUrl: string | null | undefined, base: string): boolean {
  if (!signageUrl) {
    return false;
  }
  const trimmed = stripTrailingSlashes(base);
  return signageUrl.startsWith(`${trimmed}/signage/`);
}
