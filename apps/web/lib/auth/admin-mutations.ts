import type { TenantRole } from "@kimiterrace/db";
import { getRequestOrigin } from "../http/request-origin";
import { getAdminAuth } from "./adminApp";
import { buildInAppResetLink } from "./reset-link";

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

/**
 * F11 (#508): 新規スタッフアカウントの **Identity Platform 作成 seam**。
 *
 * **uid 規約 (ADR-003 provisioning)**: Auth の **localId 自体を呼出側生成の `users.id`(UUID) に一致**
 * させて作成する (`createUser({ uid })` で localId を明示指定)。これにより `verifySessionCookie().uid`
 * (= token `sub` = localId) が `users.id` と一致し、session.ts normalizeClaims の「uid は UUID 必須」
 * 規約・既存の無効化/ロール変更 seam (users.id を uid として渡す) と整合する。`uid` という名の custom
 * claim は予約衝突で無視されるため、claim には `role` / `school_id` のみを載せる。
 *
 * **パスワード**: 初回は設定しない (createUser で password 省略)。`generatePasswordResetLink` で
 * 「初回パスワード設定リンク」を生成して返し、呼出側 (action) が発行者へ提示する (email infra 非依存、
 * 発行者が利用者へ共有)。email/password プロバイダはログイン (signInWithEmailAndPassword) 既設。
 *
 * **リンクの宛先 (自前リセットページ)**: 既定の Firebase action ハンドラ
 * (`<project>.firebaseapp.com/__/auth/action`) は英語の「Password changed」表示でログイン導線が無いため、
 * `oobCode` を取り出して自前の `{origin}/reset-password` に載せ替える (`buildInAppResetLink`)。origin は
 * 現リクエストヘッダから解決する (`getRequestOrigin`)。本 seam は **Server Action (リクエストスコープ) から
 * のみ呼ばれる**前提で、origin が解決できない場合は既定リンクにフォールバックする (発行を壊さない)。
 *
 * **部分失敗**: いずれかのステップが throw した場合、呼出側は {@link deleteIdpUser} で孤児 IdP user を
 * 補償削除すること (DB mirror 失敗時も同様、IdP=単一ソースだが DB 行の無い user は管理不能なため roll back)。
 *
 * @throws createUser が `auth/email-already-exists` 等で失敗する場合 (呼出側が conflict に整形)。
 */
export async function createIdpUser(args: {
  /** 呼出側生成の UUID。localId == users.id に一致させる (ADR-003)。 */
  uid: string;
  email: string;
  displayName: string;
  role: TenantRole;
  schoolId: string;
}): Promise<{ setupLink: string }> {
  const auth = getAdminAuth();
  // localId を uid に固定 (== users.id)。password は設定せず、後段の reset link で利用者が設定する。
  // createUser が email 重複等で throw した場合は、まだ自分が作っていないので補償不要 (呼出側が conflict 整形)。
  await auth.createUser({ uid: args.uid, email: args.email, displayName: args.displayName });
  try {
    // claims は role / school_id のみ (uid は localId で claim ではない、ADR-003)。
    await auth.setCustomUserClaims(args.uid, { role: args.role, school_id: args.schoolId });
    const firebaseLink = await auth.generatePasswordResetLink(args.email);
    // 自前リセットページに載せ替える (origin 解決不能なら既定リンクのまま = 安全側)。
    const origin = await getRequestOrigin();
    const setupLink = buildInAppResetLink(firebaseLink, origin ?? "");
    return { setupLink };
  } catch (error) {
    // createUser 成功後の部分失敗は **claims 無しの孤児 IdP user** (認証は normalizeClaims が role 欠落で
    // deny するが、email を占有して再発行を塞ぐ) を残すため、削除して seam を atomic 化してから throw する。
    await auth.deleteUser(args.uid).catch(() => {});
    throw error;
  }
}

/**
 * F11 (#508): IdP user の補償削除。{@link createIdpUser} 成功後に DB mirror / 後続が失敗した場合に、
 * 孤児 IdP user (DB 行が無く管理不能) を取り除くために呼ぶ。best-effort (補償自体の失敗は握る)。
 */
export async function deleteIdpUser(uid: string): Promise<void> {
  await getAdminAuth().deleteUser(uid);
}

/** createUser が「メール重複」で失敗したか (conflict 整形用)。firebase-admin のエラーコードで判定。 */
export function isEmailAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "auth/email-already-exists"
  );
}
