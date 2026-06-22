import { createHash, timingSafeEqual } from "node:crypto";

/**
 * staging 限定 **dev-login** の設定（秘密キー + テストアカウント資格情報）の単一ソース。**サーバー専用**。
 *
 * ## なぜ単一の JSON secret か（ルール5 Secret Manager / 最小権限）
 * dev-login は「秘密キー（?key= 突合用）」と「許可された staging テストアカウントの email+password」を必要と
 * する。これらを個別 env に散らすと secret/accessor が増え、prod へ漏れ込む面が広がる。よって **1 つの
 * Secret Manager secret（`staging-dev-login`）の JSON 値**にまとめ、Cloud Run が `DEV_LOGIN_CONFIG` env として
 * **staging のコンテナにだけ**注入する（terraform envs/staging のみ。**prod の cloud_run には配線しない**）。
 *
 * JSON 形:
 * ```json
 * { "secret": "<長いランダム>", "keyVersion": "2026-06",
 *   "teacher": { "email": "...", "password": "..." },
 *   "admin": { "email": "...", "password": "..." } }
 * ```
 *
 * `keyVersion`（任意・非 PII・非秘密）はキーのローテ世代を示すラベル。監査 diff に載せて「どの世代の鍵で
 * dev-login されたか」を後追いできるようにする（濫用調査の粒度向上・ADR-032 共通アカウントゆえ個人特定は不能）。
 * 秘密値そのものは決して載せない。未設定なら監査では `"unknown"` 相当（フィールド省略）として扱う。
 *
 * ## fail-closed 不変条件
 * - env 未設定 / 空 / JSON parse 失敗 / 必須欠落 → すべて **null**（= route が 404 を返す）。
 *   prod は `DEV_LOGIN_CONFIG` が存在しないため常に null（鍵検証もアカウント解決も不能）。
 * - **任意 email/uid は受け取らない**: 解決できるアカウントは config に静的に書かれた teacher / admin のみ。
 * - 秘密値（password / secret）は決して例外メッセージ・ログに出さない（ルール5）。
 */

/** dev-login が受け付けるロール（固定 allowlist）。これ以外のアカウントは決して解決しない。 */
export type DevLoginRole = "teacher" | "admin";

/** dev-login テストアカウント 1 件分の資格情報。 */
type DevLoginAccount = { email: string; password: string };

/** dev-login の解決済み設定（secret + 各ロールのテストアカウント）。 */
export type DevLoginConfig = {
  /** Authorization ヘッダの Bearer トークンと定数時間で突合する秘密キー。 */
  secret: string;
  /** 鍵ローテ世代ラベル（任意・非 PII・非秘密）。監査 diff に記録する。未設定なら null。 */
  keyVersion: string | null;
  /** ?role=teacher で使う staging テスト教員アカウント。 */
  teacher: DevLoginAccount;
  /** ?role=admin で使う staging テスト学校管理者アカウント。 */
  admin: DevLoginAccount;
};

/** 入力文字列を DevLoginRole に正規化する。許可外は null（任意ロール禁止）。 */
export function toDevLoginRole(value: string | null | undefined): DevLoginRole | null {
  return value === "teacher" || value === "admin" ? value : null;
}

function parseAccount(value: unknown): DevLoginAccount | null {
  if (typeof value !== "object" || value === null) return null;
  const { email, password } = value as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || email.length === 0) return null;
  if (typeof password !== "string" || password.length === 0) return null;
  return { email, password };
}

/**
 * `DEV_LOGIN_CONFIG` env を読み、検証済み設定を返す。未設定 / 不正はすべて null（fail-closed）。
 *
 * **この関数が null を返すこと = dev-login が機能しないこと**。prod では env 不在で常に null。
 */
export function getDevLoginConfig(): DevLoginConfig | null {
  const raw = process.env.DEV_LOGIN_CONFIG;
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 設定不備（不正 JSON）は安全側で無効化（理由はログに出さない＝secret 断片の漏洩防止）。
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { secret, keyVersion, teacher, admin } = parsed as {
    secret?: unknown;
    keyVersion?: unknown;
    teacher?: unknown;
    admin?: unknown;
  };
  if (typeof secret !== "string" || secret.length === 0) return null;
  const teacherAccount = parseAccount(teacher);
  const adminAccount = parseAccount(admin);
  if (!teacherAccount || !adminAccount) return null;
  // keyVersion は任意。文字列でなければ無視（null）。不正値でも config 全体は無効化しない（秘密ではないため）。
  const version = typeof keyVersion === "string" && keyVersion.length > 0 ? keyVersion : null;
  return { secret, keyVersion: version, teacher: teacherAccount, admin: adminAccount };
}

/**
 * 提供キーが設定済み secret に一致するか（定数時間比較・fail-closed）。
 *
 * - config 未解決（env 不在・不正） → false。
 * - 提供キー欠如 / 空 → false。
 * - 長さ差で早期 return しないよう、双方を SHA-256 で固定長に潰してから `timingSafeEqual`
 *   （tv/poll-secret・provision-agent-secret と同方針）。
 */
export function verifyDevLoginKey(provided: string | null | undefined): boolean {
  const config = getDevLoginConfig();
  if (!config) return false;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const digest = (v: string): Buffer => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(config.secret));
}

/** 指定ロールの staging テストアカウント資格情報を返す。config 未解決なら null。 */
export function getDevLoginAccount(role: DevLoginRole): DevLoginAccount | null {
  const config = getDevLoginConfig();
  if (!config) return null;
  return role === "teacher" ? config.teacher : config.admin;
}

/**
 * 監査記録用の鍵世代ラベル（非 PII・非秘密）。config 未解決 / 未設定なら null。
 * **秘密値（secret 本体）は決して返さない**。返すのはローテ世代の識別ラベルのみ。
 */
export function getDevLoginKeyVersion(): string | null {
  return getDevLoginConfig()?.keyVersion ?? null;
}
