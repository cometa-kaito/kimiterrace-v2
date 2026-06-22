import { createHash, timingSafeEqual } from "node:crypto";

/**
 * staging 限定 **dev-login** の設定（**ゲート鍵のみ**）の単一ソース。**サーバー専用**。
 *
 * ## 真のパスワードレス化（password を保存も要求もしない）
 * 旧実装は teacher/admin の **email + password** を config に保存し `signInWithPassword` でサインインしていた
 * （staging の実パスワードを誰も知らず運用不能だった）。新方式は **uid から直接セッションを発行**する
 * （apps/web の session.createSessionCookieForUid: custom token → idToken → session cookie）。よって config に
 * **パスワードは一切持たない**。config が持つのは「dev-login を起動してよいか」を判定する **ゲート鍵（secret）**
 * だけに縮小する。対象アカウント（teacher/admin の uid）は DB / IdP 側から解決する（dev-login.ts）。
 *
 * ## なぜ単一の JSON secret か（ルール5 Secret Manager / 最小権限）
 * ゲート鍵を 1 つの Secret Manager secret（`staging-dev-login`）の JSON 値にまとめ、Cloud Run が
 * `DEV_LOGIN_CONFIG` env として **staging のコンテナにだけ**注入する（terraform envs/staging のみ。**prod の
 * cloud_run には配線しない**）。
 *
 * JSON 形（新・最小）:
 * ```json
 * { "secret": "<長いランダム>", "keyVersion": "2026-06" }
 * ```
 * 任意で「解決対象を固定したい」場合のみ email/校ヒントを足せる（password は決して持たない）:
 * ```json
 * { "secret": "...", "teacher": { "schoolId": "<uuid>" }, "admin": { "uid": "<uuid>" } }
 * ```
 *
 * `keyVersion`（任意・非 PII・非秘密）はキーのローテ世代ラベル。監査 diff に載せて追跡する。秘密値（secret）は
 * 決して例外メッセージ・ログに出さない（ルール5）。
 *
 * ## fail-closed 不変条件
 * - env 未設定 / 空 / JSON parse 失敗 / secret 欠落 → すべて **null**（= route が 404）。prod は env 不在で常に null。
 * - **任意 email/uid をリクエストから受け取らない**: ロールは teacher / admin の固定 allowlist のみ。
 * - 秘密値（secret）は決して例外メッセージ・ログに出さない（ルール5）。
 */

/** dev-login が受け付けるロール（固定 allowlist）。これ以外は決して解決しない。 */
export type DevLoginRole = "teacher" | "admin";

/**
 * 解決対象の任意ヒント（password を持たない）。指定があれば dev-login.ts の解決がこれを優先する。
 * - teacher: `schoolId` を指定するとその学校の共通教員を対象にする。
 * - admin: `uid` を指定するとその school_admin（users.id）を対象にする。
 * いずれも未指定なら DB から既存解決し、無ければ dev 専用テストアカウントを冪等作成する。
 */
export type DevLoginResolveHint = { schoolId?: string; uid?: string };

/** dev-login の解決済み設定（ゲート鍵 + 任意の解決ヒント）。**password は持たない**。 */
export type DevLoginConfig = {
  /** Authorization ヘッダの Bearer トークンと定数時間で突合するゲート鍵。 */
  secret: string;
  /** 鍵ローテ世代ラベル（任意・非 PII・非秘密）。監査 diff に記録する。未設定なら null。 */
  keyVersion: string | null;
  /** teacher 解決の任意ヒント（schoolId）。password は含まない。 */
  teacher: DevLoginResolveHint | null;
  /** admin 解決の任意ヒント（uid）。password は含まない。 */
  admin: DevLoginResolveHint | null;
};

/** 入力文字列を DevLoginRole に正規化する。許可外は null（任意ロール禁止）。 */
export function toDevLoginRole(value: string | null | undefined): DevLoginRole | null {
  return value === "teacher" || value === "admin" ? value : null;
}

/**
 * 解決ヒントをパースする。object 以外 / 未指定は null。`schoolId` / `uid` は string のときだけ採る。
 * **password 等の余分なキーは無視**（万一 config に残っていても拾わない＝秘密を持ち回らない）。
 */
function parseHint(value: unknown): DevLoginResolveHint | null {
  if (typeof value !== "object" || value === null) return null;
  const { schoolId, uid } = value as { schoolId?: unknown; uid?: unknown };
  const hint: DevLoginResolveHint = {};
  if (typeof schoolId === "string" && schoolId.length > 0) hint.schoolId = schoolId;
  if (typeof uid === "string" && uid.length > 0) hint.uid = uid;
  return hint.schoolId || hint.uid ? hint : null;
}

/**
 * `DEV_LOGIN_CONFIG` env を読み、検証済み設定を返す。未設定 / 不正 / secret 欠落はすべて null（fail-closed）。
 *
 * **この関数が null を返すこと = dev-login が機能しないこと**。prod では env 不在で常に null。
 * 必須は secret のみ（旧実装の teacher/admin password 必須は撤廃）。
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
  // keyVersion は任意。文字列でなければ無視（null）。不正値でも config 全体は無効化しない（秘密ではないため）。
  const version = typeof keyVersion === "string" && keyVersion.length > 0 ? keyVersion : null;
  return {
    secret,
    keyVersion: version,
    teacher: parseHint(teacher),
    admin: parseHint(admin),
  };
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

/** 指定ロールの解決ヒントを返す（任意）。config 未解決 / ヒント無しは null。password は決して返さない。 */
export function getDevLoginResolveHint(role: DevLoginRole): DevLoginResolveHint | null {
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
