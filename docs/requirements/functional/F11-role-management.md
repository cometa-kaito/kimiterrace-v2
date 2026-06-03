# F11: ロール管理

- 状態: 実装中（無効化/再有効化・ロール変更・全校横断/自校 教職員一覧・認可ポリシー・last-admin 多層防御は実装済。新規アカウント発行=初期ロール任命の操作系と MFA 強制は未実装）
- 関連 ADR: ADR-003 (Identity Platform), [ADR-026 (無効化/ロール変更エンフォース経路)](../../adr/026-account-deactivation-role-change-enforcement.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#47](https://github.com/cometa-kaito/kimiterrace-v2/issues/47), [#324](https://github.com/cometa-kaito/kimiterrace-v2/issues/324)

## 概要

system_admin が school_admin を任命、school_admin が teacher を任命する権限階層を実装する。

## ユーザーストーリー

- **システム管理者として**、新校導入時に school_admin を任命したい。
- **校務管理者として**、自校の教員アカウントを発行・無効化したい。**なぜなら**異動・退職に運用追従するため。

## 受け入れ条件

- [~] system_admin は全ロール付与可 — 部分実装（[#275](https://github.com/cometa-kaito/kimiterrace-v2/pull/275)、[#343](https://github.com/cometa-kaito/kimiterrace-v2/pull/343)、[#349](https://github.com/cometa-kaito/kimiterrace-v2/pull/349)、[#363](https://github.com/cometa-kaito/kimiterrace-v2/pull/363)、`apps/web/lib/role-management/policy.ts`、`apps/web/lib/system-admin/users-actions.ts`）残: 認可ポリシー（`canAssignRole`）と既存ユーザーへの全校横断ロール変更/無効化は実装済だが、新規アカウント発行=初期ロール付与の操作系は未配線
- [~] school_admin は同 school_id の teacher のみ発行可 — 部分実装（[#275](https://github.com/cometa-kaito/kimiterrace-v2/pull/275)、[#318](https://github.com/cometa-kaito/kimiterrace-v2/pull/318)、[#336](https://github.com/cometa-kaito/kimiterrace-v2/pull/336)、`apps/web/lib/role-management/policy.ts`、`apps/web/lib/role-management/member-actions.ts`）残: 自校 teacher への操作（一覧・無効化/再有効化）と認可ポリシーは実装済だが、「発行」= 新規 teacher アカウント作成フローは未実装
- [x] teacher は他人のロール変更不可 — 実装済（[#275](https://github.com/cometa-kaito/kimiterrace-v2/pull/275)、[#336](https://github.com/cometa-kaito/kimiterrace-v2/pull/336)、[#363](https://github.com/cometa-kaito/kimiterrace-v2/pull/363)、`apps/web/lib/role-management/policy.ts`、`apps/web/lib/auth/guard.ts`：`canModifyTargetUser` teacher→deny + requireRole で teacher を /forbidden へ）
- [x] ロール変更は全件 audit_log — 実装済（[#336](https://github.com/cometa-kaito/kimiterrace-v2/pull/336)、[#349](https://github.com/cometa-kaito/kimiterrace-v2/pull/349)、[#363](https://github.com/cometa-kaito/kimiterrace-v2/pull/363)、`apps/web/lib/system-admin/users-actions.ts`、`apps/web/lib/role-management/member-actions.ts`：変更/無効化を before/after diff で DB mirror と同一 tx に記録）
- [x] custom claims は Cloud Functions / Cloud Run の特権ロール経由でのみ更新（フロントから直接書込み不可）— 実装済（[#336](https://github.com/cometa-kaito/kimiterrace-v2/pull/336)、[#363](https://github.com/cometa-kaito/kimiterrace-v2/pull/363)、[#326](https://github.com/cometa-kaito/kimiterrace-v2/pull/326)、`apps/web/lib/auth/admin-mutations.ts`：サーバー専用 Admin SDK seam が `setCustomUserClaims` + `revokeRefreshTokens` を実行、"use server" Action からのみ呼出、フロント直接経路なし。ADR-026 D2/D3）
- [~] MFA（teacher 以上、[NFR03](../non-functional/NFR03-security.md)）— **2026-06-03 ユーザー確定: 段階的エンフォース（[ADR-031](../../adr/031-mfa-phased-enforcement.md)）**。capability（IdP `mfa_config` 有効化 + アプリ側の multiFactor enrollment フロー）を MVP で実装するが、岐南工業 PoC では**任意**（教員の初期導入摩擦を避ける）、**本番導入ゲートで teacher 以上に強制化**して NFR03 を満たす。現状未実装（Terraform `mfa_config` 未設定の TODO、アプリ側 enrollment/enforcement なし）→ ADR-031 に従い実装予定
- [x] アカウント無効化時に既存 magic_link は失効しない（クラス単位の link は教員紐付けではないため）— 実装済（`deactivateIdpUser` は IdP disable + revokeRefreshTokens のみで `magic_links` を touch せず、magic link は student class-level token として独立。教員との関連付けは `user_id` でなく監査列 `created_by` で、`resolve_magic_link` は `revoked_at IS NULL`+未期限のみで判定し発行教員を参照しない）。回帰テストで pin 済（`packages/db/__tests__/rls/magic-links.test.ts`：発行教員 created_by を `is_active=false`〔IdP 無効化の DB mirror〕にしても class link が解決でき revoked_at が NULL のままを実 PG で実証）

## 権限マトリクス

| 操作 | system_admin | school_admin | teacher |
|---|:-:|:-:|:-:|
| system_admin 任命 | ✅ | ❌ | ❌ |
| school_admin 任命 | ✅ | ❌ | ❌ |
| teacher 任命 | ✅ | ✅ (自校) | ❌ |
| 自身のパスワード変更 | ✅ | ✅ | ✅ |
| 他者のロール変更 | ✅ | 自校 teacher のみ | ❌ |
| アカウント無効化 | ✅ | 自校 teacher のみ | ❌ |

## 関連

- ロール設計: [v2-mvp.md §3](../v2-mvp.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR04](../non-functional/NFR04-audit-log.md)
- 多層防御（last-admin）: [#392](https://github.com/cometa-kaito/kimiterrace-v2/pull/392)（app 層 TOCTOU 根治）/ [#402](https://github.com/cometa-kaito/kimiterrace-v2/pull/402)（L1 race 検出ログ）/ [#414](https://github.com/cometa-kaito/kimiterrace-v2/pull/414)（L2 DB トリガで各校 有効 school_admin≥1）/ [#405](https://github.com/cometa-kaito/kimiterrace-v2/pull/405)（L3 実 PG 並行テスト）
- テスト: `__tests__/api/roles/`, `__tests__/rls/role-based/`
