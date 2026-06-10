# ADR-032: 教員「学校共通パスワード」ログイン

- Status: Accepted
- Date: 2026-06-08
- Deciders: ユーザー（運営）/ Claude
- 関連: [ADR-003 Identity Platform](003-identity-platform.md) を **augment**（覆さない）。[ADR-026 アカウント無効化/ロール変更](026-account-deactivation-role-change-enforcement.md) / ADR-019（二層 RLS）と整合。

## コンテキスト

学校から「教員ごとに ID を発行・登録するのは工数が高い。教員は**パスワードのみ**でログインできれば良い（4 桁以上）」という要望（2026-06-08 ユーザー確定）。ログイン画面は教員が最多ロールのため、教員向けの「パスワード入力のみ」を中心に設計する。

従来は ADR-003 に基づき全ロールが Identity Platform の **email + password 個別アカウント**でログインしていた。教員に個別アカウントを発行・運用する前提を、学校運用負荷の観点から見直す必要がある。

## 決定

**学校ごとに 1 つの「共通教員アカウント」を Identity Platform に用意し、教員はその学校共通パスワードのみでログインする。** 個人ごとのアカウント/ID 登録は行わない。

ユーザーは「学校共通パスワード 1 つ」方式を明示選択し、**操作の個人帰属（監査ルール1 の who）が失われる点を受容**した（全教員が同一の共通アカウントとして記録される）。

### 実装（ADR-003 の認証経路を維持）

1. **共通教員アカウント**: 学校 id から決定的に導く `uid`（UUIDv5、`localId == users.id` を満たす）と `email`（`t-<schoolId>@teacher.kimiterrace.invalid`、`.invalid` は送信されない予約 TLD）を持つ IdP アカウント。custom claims = `{ role: "teacher", school_id }`。
2. **パスワード保管は IdP のみ**: 共通パスワードは Identity Platform（Google がハッシュ保管）に置き、**本アプリ DB には平文もハッシュも保存しない**（ルール5）。`schools.teacher_login_enabled`（boolean）だけを持ち、「この学校が共通ログインを提供しているか」を表す。
3. **ログイン経路**: `POST /api/auth/teacher-login` がサーバー側で IdP REST `signInWithPassword`（共通教員 email + 入力パスワード）を実行し、得た idToken を既存の `createSessionCookie` で `__session` cookie 化する。`createCustomToken`（`iam.serviceAccounts.signBlob` 権限が必要）は**使わない**ため、追加の IAM/Terraform 変更が不要。
4. **provisioning**: system_admin が学校編集で共通パスワードを設定すると、`createUser`/`updateUser` + `setCustomUserClaims`（いずれも Auth REST、署名不要）でアカウントを用意し、`users` 行（`created_by` FK 充足用）と `teacher_login_enabled=true` を設定する。
5. **セッション検証は不変**: `verifySessionCookie`（ADR-003）/ RLS context（ADR-019）はそのまま。`decoded.uid` = 共通教員 `users.id`、`role=teacher`、`school_id` で従来どおり動作する。auth core seam（session.ts / getCurrentUser）は変更しない。

### セキュリティ上のトレードオフと緩和

- **個人帰属の喪失**（受容済）: audit_log の actor は学校の共通教員になる。誰が操作したかの個人特定はできない。
- **短いパスワードの総当たり**: 最短 **6 文字**（Identity Platform の email/password 下限。パスワードポリシー最小長は 6〜30 で 6 未満不可。当初 4 文字を企図したが IdP が `auth/invalid-password` で拒否するため 6 に整合）。短いほど総当たり耐性は弱いため緩和: ①ログイン route で**失敗回数のみ**を IP 単位でレート制限（成功＝学校 NAT 共有の一斉ログインは非計上）、②理由を畳んだ 401（学校/パスワードの列挙を防ぐ）、③volume の最終防壁は WAF/Cloud Armor、④UI で英数字・長めのパスワードを推奨。将来、より強い MFA/長さ強制が必要なら別 ADR。
- **password rotation**: 共通パスワード変更時は `revokeRefreshTokens` で既存セッションを失効（ADR-026 と同様の即時反映）。

## 代替案（不採用）

- **教員ごと自己登録（氏名選択 + 個人 PW）**: 個人帰属を保てるが「パスワードのみ」ではなく、ユーザーは共通パスワードを選択。
- **`createCustomToken` による session 発行**: 実行 SA に `signBlob`（Token Creator）権限が要り、Terraform で IAM 追加 + apply が必要。staging 自律デプロイのリスクを増やすため不採用。`signInWithPassword`（REST）で同等を権限追加なしに実現。
- **自前 HMAC cookie**: auth core seam（getCurrentUser）を改変する必要があり、ADR-003 の検証経路を弱める。不採用。

## 影響

- 新規: `schools.teacher_login_enabled` 列、`/api/auth/teacher-login`、共通教員 provisioning（system_admin の学校編集）、ログイン画面の教員ファースト化。
- 既存の email+password ログイン（school_admin / system_admin / 個別 teacher アカウントがあれば）は維持。ログイン画面で「職員/管理者ログイン」へ切替可能にする。
