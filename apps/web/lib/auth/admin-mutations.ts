import type { TenantRole } from "@kimiterrace/db";
import { getAdminAuth } from "./adminApp";

/**
 * F11 (#324, ADR-026): アカウント無効化 / ロール変更の **Identity Platform エンフォース seam**。
 *
 * ADR-026 の決定: **IdP を認証エンフォースの単一ソースとし、DB の `users.is_active` / `users.role` は
 * IdP 状態の mirror (表示・監査用の投影) に留める**。claims / トークン有効性こそがエンフォースの根拠
 * なので、状態変更は「DB を書く」だけでは不十分で、**必ず IdP 側を更新する**ことを操作の一部として
 * 強制する (DB-only mutation を「無効化」と称さない = ADR-026 D3)。
 *
 * **サーバー専用** (firebase-admin / Admin SDK)。Server Action からのみ呼ぶ。`uid` は Identity Platform の
 * localId を渡す — provisioning 前提により localId == `users.id`(UUID) (ADR-003、session.ts の
 * normalizeClaims docstring 参照)。
 *
 * 無効化 / 再有効化 (ADR-026 D1) と **ロール変更 (D2、`changeIdpUserRole`)** を提供する。
 */

/**
 * ADR-026 D1: アカウント無効化。**2 段で失効を確定させる**:
 *
 * 1. **IdP ユーザーを disable** (`updateUser(uid, { disabled: true })`) — 以後の新規トークン発行 /
 *    リフレッシュを停止 (再ログイン不可)。
 * 2. **リフレッシュトークンを失効** (`revokeRefreshTokens(uid)`) — **既存の session cookie を次リクエスト
 *    で無効化**。`verifySessionCookie` の既定 `checkRevoked = true` が失効時刻以降のトークンを拒否する
 *    (追加のコード変更なしでエンフォースが効く)。
 *
 * `revokeRefreshTokens` を省くと、既存 cookie が有効期間 (最大 14 日) 残存してログイン・操作を継続でき、
 * 「無効化」が security theater になる (#324 の核心)。`disabled` (1) だけに頼らず revoke (2) で確定保証
 * する二層構成 — `checkRevoked` が disabled ユーザーを直接弾くかは firebase-admin のバージョン挙動に
 * 依存させない (ADR-026 注記)。
 */
export async function deactivateIdpUser(uid: string): Promise<void> {
  const auth = getAdminAuth();
  // disable を先に成立させてから revoke する (再ログイン経路を塞いだ上で既存トークンを失効)。
  await auth.updateUser(uid, { disabled: true });
  await auth.revokeRefreshTokens(uid);
}

/**
 * ADR-026 D1: 再有効化 (無効化の逆操作)。IdP ユーザーを enable する。
 *
 * トークンは利用者が **再ログインで取得**するため、ここでは revoke しない (失効済みのまま enable して
 * よい — 利用者が新規にサインインすれば有効なトークンを得られる)。
 */
export async function reactivateIdpUser(uid: string): Promise<void> {
  await getAdminAuth().updateUser(uid, { disabled: false });
}

/**
 * ADR-026 D2: ロール変更。**claims がロールの単一ソース**なので、claims を再付与し **必ず revoke する**。
 *
 * 1. **claims を再付与** (`setCustomUserClaims(uid, { role, school_id })`) — 新ロールを claims に反映。
 *    custom claims は全置換なので、`normalizeClaims` が読む `role` / `school_id` を完全な形で渡す
 *    (`uid` は localId であり custom claim ではない、session.ts 参照)。
 * 2. **リフレッシュトークンを失効** (`revokeRefreshTokens(uid)`)。**降格 (school_admin→teacher) では
 *    revoke しないと旧特権 claim が cookie 有効期間 (最大 14 日) 残存して危険**なため revoke は必須。
 *    昇格も同様に一旦失効 → 利用者は再ログインで新ロールの claim を取得する (revoke 後の既存 session は
 *    自動で新ロールに変わるのではなく、`checkRevoked` で deny に倒れ「再ログイン強制」になる)。
 *
 * `schoolId` はテナント claim (school_admin / teacher は所属校 UUID)。本 seam は教職員ロール間の変更
 * (school_admin ↔ teacher) に使い、school 横断や system_admin 化はしない (呼出側 action が role を限定)。
 */
export async function changeIdpUserRole(
  uid: string,
  role: TenantRole,
  schoolId: string,
): Promise<void> {
  const auth = getAdminAuth();
  // claims を先に確定してから revoke する (新ロールを載せた上で既存 session を失効 = 再ログインで新権限)。
  await auth.setCustomUserClaims(uid, { role, school_id: schoolId });
  await auth.revokeRefreshTokens(uid);
}
