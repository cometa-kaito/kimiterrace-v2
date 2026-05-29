# F05: クラス magic link 発行 / 生徒匿名アクセス

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-016 (magic link 匿名アクセス, 起票予定), ADR-003 (Identity Platform)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

教員がクラス単位で 1 つの magic link を発行。生徒は個人ログインせず、その URL からスマホ/タブレットで閲覧する。

## ユーザーストーリー

- **教員として**、クラス全員に 1 つの URL を配布したい。**なぜなら**生徒ごとアカウント発行は運用が重く、卒業・転入で破綻するから。
- **生徒として**、個人情報を入力せず気軽にアクセスしたい。

## 受け入れ条件

- [ ] magic_link テーブル: `id (uuid)`, `school_id`, `class_id`, `token (短縮 URL 用)`, `expires_at`, `revoked_at`, 監査カラム
- [ ] 有効期限デフォルト 90 日、教員 UI から短縮/延長/失効可能
- [ ] 生徒アクセス時にセッション cookie を発行（ブラウザ閉じても 24h 保持）。個人特定情報は一切持たない
- [ ] アクセス元 IP・User-Agent は events テーブルに記録（個人特定はしない、集計用）
- [ ] 失効後アクセスは 410 Gone レスポンス
- [ ] QR コード生成機能（教員 UI 上で印刷可能）
- [ ] 漏洩検知時の即時失効フロー (runbook 化)

## 関連

- 後段: [F06 (生徒対話)](F06-student-qa.md), [F07 (イベントログ)](F07-event-logging.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md)
- テスト: `__tests__/api/magic-links/`, `__tests__/e2e/student-access/`
