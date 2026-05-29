# F10: CRM（広告主マスタ・契約・コミュニケーション履歴）

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-018 (CRM 独自設計, 起票予定)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

広告主はシステム外だが、社内管理用に CRM 機能を持つ。広告主マスタ、契約期間・金額、訪問記録・メールやり取りの履歴を一元管理する。

## ユーザーストーリー

- **システム管理者として**、広告主への月次レポート配布前に契約状況・直近の会話を素早く確認したい。**なぜなら**専用 CRM (HubSpot 等) を別契約せず、本システム内で完結したいから。

## 受け入れ条件

- [ ] advertisers テーブル: 会社名、担当者、連絡先、ステータス（見込/契約中/休止）、業種
- [ ] contracts テーブル: 広告主 × 学校 × 期間 × 金額 × 出稿コンテンツ
- [ ] communications テーブル: 訪問記録、メール内容（手動入力 or 貼付け）、添付ファイル
- [ ] system_admin のみアクセス可（school_admin は閲覧不可）
- [ ] 全データはテナント横断（school_id を持たない）
- [ ] CRM テーブルは RLS の対象外（system_admin の application-level チェックで保護）

## 関連

- 後段: [F09 (月次レポート)](F09-monthly-report.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR04](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/crm/`, `__tests__/rls/non-tenant-tables/`
