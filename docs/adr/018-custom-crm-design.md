# ADR-018: CRM 機能の独自設計（既存 SaaS 連携を採用しない）

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-28
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [F10](../requirements/functional/F10-crm.md), [F09](../requirements/functional/F09-monthly-report.md), [v2-mvp.md §3](../requirements/v2-mvp.md)

## 文脈

広告主管理機能（広告主マスタ・契約・コミュニケーション履歴）を実装する必要がある。
広告主は **システム外**（直接ログインしない）で、system_admin が月次レポートを対面/メールで配布する運用モデル（[v2-mvp.md §3](../requirements/v2-mvp.md)）。

選択肢:
- 既存 CRM SaaS（HubSpot / Salesforce）と連携
- ノーコード DB（Notion / Airtable）に外部化
- 独自設計（advertisers / contracts / communications テーブルを本システム内に持つ）
- スプレッドシート手動運用（CRM 機能を実装しない）

特性として:
1. 広告主数は 20 社規模が目安（[memory: project_kimiterrace_business_model](../../.claude/projects/.../memory/project_kimiterrace_business_model.md)）。SaaS 契約コストに見合うほど大規模ではない
2. 月次レポート生成（[F09](../requirements/functional/F09-monthly-report.md)）は広告主 × 学校 × 期間の関連付けが必要で、本システム内に契約データを持つほうが結合容易
3. 外部 SaaS 連携は API キー管理・データ同期不整合・外部障害伝播のリスクが増える
4. [memory: feedback_closed_system_security](../../.claude/projects/.../memory/feedback_closed_system_security.md): 自校内完結を優先、外部連携は攻撃面を広げる

## 決定

**独自設計を採用**。本システム内に以下のテーブルを持つ:

| テーブル | 役割 |
|---|---|
| advertisers | 会社名、担当者、連絡先、ステータス（見込/契約中/休止）、業種 |
| contracts | 広告主 × 学校 × 期間 × 金額 × 出稿コンテンツ |
| communications | 訪問記録、メール内容（手動入力/貼付け）、添付ファイル |

- **system_admin のみアクセス可**（school_admin は閲覧不可）
- 全データはテナント横断（school_id を持たない）
- CRM テーブルは RLS の対象外（アプリケーション層で system_admin チェック）
- 広告主は **直接ログインしない**。広告主向け管理画面は Phase 2 送り

## 検討した代替案

### 代替 A: HubSpot 連携
- 却下理由: 月額コスト（広告主 20 社規模では割高）
- 副次理由: API キー管理 + 同期不整合リスク + 外部 SaaS への PII 流出懸念
- 副次理由: [memory: feedback_closed_system_security](../../.claude/projects/.../memory/feedback_closed_system_security.md) (自校内完結) と矛盾

### 代替 B: Salesforce 連携
- 却下理由: HubSpot より重量級、運用コスト/契約コストが規模に合わない
- 副次理由: 教育機関向けでも導入オーバーヘッドが大きい

### 代替 C: Notion DB / Airtable
- 却下理由: API ベースの同期は実装したものの、契約金額や月次レポートとの結合に SQL JOIN が使えず F09 実装が複雑化
- 副次理由: 監査ログを [NFR04](../requirements/non-functional/NFR04-audit-log.md) と同基準で運用するのが困難

### 代替 D: スプレッドシート手動運用（CRM 機能を実装しない）
- 却下理由: 月次レポート（[F09](../requirements/functional/F09-monthly-report.md)）の自動生成に必要な「広告主 × 学校 × 期間」の構造化データが取れない
- 副次理由: system_admin の業務効率が低下（訪問前の状況確認に時間がかかる）

## 結果（Consequences）

### 良い影響

- 月次レポート生成時に同一 DB 内の JOIN で完結し、F09 実装がシンプル
- 外部 SaaS 依存ゼロ、攻撃面を広げない
- 監査ログを本システムと同基準（[NFR04](../requirements/non-functional/NFR04-audit-log.md) hash chain 改竄検知含む）で運用
- 広告主データの整合性管理が一元化
- 将来「広告主向け管理画面」を追加する場合、本テーブルに RLS-like なポリシーを後付けすれば対応可能

### 悪い影響 / リスク

- **CRM 機能を自前実装するため、開発コスト発生**: 一般的な CRM ソフトより機能は最小限になる（パイプライン管理、メール統合、レポート作成等は持たない）
- **広告主数が大幅に増加した場合のスケール**: 数百社規模になった場合、独自 CRM の UI/UX 不足が顕在化する可能性 → その時点で SaaS 連携 ADR を新規起票
- **CRM テーブルは RLS 対象外**: アプリ層チェックの不備が全広告主データ漏洩に直結 → middleware の system_admin チェック必須化、テストで保証

### トレードオフ

- 「機能の豊富さ vs 統合の容易さ」のうち **統合の容易さ** に振った設計
- 「将来の拡張性 vs 現在の運用簡素」のうち **現在の運用簡素** に振った設計
- 「外部 SaaS 連携 vs 自校内完結」のうち **自校内完結** に振った設計（[memory: feedback_closed_system_security](../../.claude/projects/.../memory/feedback_closed_system_security.md) と整合）
- 広告主数 100 社超 / 商談パイプライン管理要 / 専任セールス採用、いずれかが現実化したら本 ADR を Superseded として再評価
