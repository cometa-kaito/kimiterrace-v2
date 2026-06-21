import { auditLog } from "@kimiterrace/db";
import { withUserSession } from "../db";
import { extractClientMeta } from "../magic-link/client-meta";
import { type DevLoginRole, getDevLoginAccount } from "./dev-login-config";
import { signInWithEmailPassword } from "./password-sign-in";
import type { AuthUser } from "./session";

/**
 * staging 限定 **dev-login** のサインインと監査記録（ADR-003 / ADR-032）。**サーバー専用**。
 *
 * 「パスワードを打たずに」セッションを得る手段だが、**任意の email/uid を受け取らない**。許可ロール
 * （teacher / admin）に静的に紐づく **staging のテストアカウント**（`DEV_LOGIN_CONFIG` JSON、Secret Manager）
 * のみを `signInWithEmailPassword`（既存の認証経路を再利用）でサインインして idToken を得る。idToken は
 * route 側で `createSessionCookie` に渡し、通常ログインと同一の `__session` を発行する（= 本物のセッション。
 * RLS の school スコープが正しく効く）。
 *
 * ## 「新規ユーザーを作らない」不変条件
 * 本モジュールは `createUser` / `setCustomUserClaims` を**一切呼ばない**。config に書かれた既存テスト
 * アカウントの email + password で signIn するだけ。dev-login が新しい IdP アカウントを生やすことはない。
 */

/**
 * 指定ロールの staging テストアカウントでサインインし idToken を得る。
 *
 * 資格情報未設定（config 不在）/ サインイン失敗（パスワード不一致・アカウント不在）はすべて **null**
 * （route が 404 に写像）。**任意 email/uid は受け取らず**、config で固定されたテストアカウントのみ。
 */
export async function devLoginSignIn(role: DevLoginRole): Promise<string | null> {
  const account = getDevLoginAccount(role);
  if (!account) return null;
  return await signInWithEmailPassword(account.email, account.password);
}

/**
 * dev-login の使用を `audit_log` に追記する（CLAUDE.md ルール1 / NFR04）。
 *
 * **既に発行済みセッションの actor（解決済み AuthUser）として記録する**: dev-login で得た idToken を
 * `verifySessionCookie` で検証した結果の user をそのまま RLS context に張り（`withUserSession`）、その user の
 * `actor_user_id` / `school_id` で 1 行 insert する。これにより「staging で誰のセッションとして dev-login が
 * 使われたか」を、漏洩時にも append-only chain で立証できる。`audit_op` に read が無いため
 * `dev_login_access` 論理 subject への insert として記録する（download-audit / view-audit と同方針）。
 *
 * 失敗（DB エラー等）は **throw せず握り潰す**: 監査記録の失敗で正規のサインインを巻き戻さない（dev-login の
 * ログイン自体は成立済み）。記録漏れは別途検知する想定。秘密値は diff に載せない。
 */
export async function recordDevLoginAudit(
  user: AuthUser,
  role: DevLoginRole,
  requestHeaders: Headers,
): Promise<void> {
  const { ip, userAgent } = extractClientMeta(requestHeaders);
  const isSystemAdmin = user.role === "system_admin";
  // 非 system_admin（teacher / school_admin）は audit_log_insert policy 上 actor_user_id を自分の uid に
  // 完全一致させる必要がある（NULL / 詐称は拒否、migration 0005）。dev-login の対象は teacher / admin のみ。
  const actorUserId = isSystemAdmin ? null : user.uid;
  try {
    await withUserSession(user, async (tx) => {
      await tx.insert(auditLog).values({
        actorUserId,
        actorIdentityUid: user.uid,
        schoolId: user.schoolId ?? null,
        tableName: "dev_login_access",
        recordId: null,
        operation: "insert",
        // PII / 秘密値は載せない。どのロールで staging dev-login したかのメタのみ。
        diff: { action: "dev_login", role },
        ipAddress: ip,
        userAgent,
        rowHash: "",
        createdBy: actorUserId,
        updatedBy: actorUserId,
      });
    });
  } catch {
    // 監査記録の失敗で正規サインインを巻き戻さない（ベストエフォート）。理由はログに出さない（ルール5）。
  }
}
