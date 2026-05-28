# F11: ロール管理

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §3, §4 から分割）
- 関連 ADR: ADR-003 (Identity Platform)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

system_admin が school_admin を任命、school_admin が teacher を任命する権限階層を実装する。

## ユーザーストーリー

- **システム管理者として**、新校導入時に school_admin を任命したい。
- **校務管理者として**、自校の教員アカウントを発行・無効化したい。**なぜなら**異動・退職に運用追従するため。

## 受け入れ条件

- [ ] system_admin は全ロール付与可
- [ ] school_admin は同 school_id の teacher のみ発行可
- [ ] teacher は他人のロール変更不可
- [ ] ロール変更は全件 audit_log
- [ ] custom claims は Cloud Functions / Cloud Run の特権ロール経由でのみ更新（フロントから直接書込み不可）
- [ ] MFA 強制（teacher 以上、[NFR03](../non-functional/NFR03-security.md)）
- [ ] アカウント無効化時に既存 magic_link は失効しない（クラス単位の link は教員紐付けではないため）

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
- テスト: `__tests__/api/roles/`, `__tests__/rls/role-based/`
