# F07: イベントロギング

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-014 (Observability), ADR-001 (PostgreSQL)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

生徒のサイネージ閲覧・タップ・遷移を全て記録。効果可視化と AI 改善の基盤データになる。

## ユーザーストーリー

- **学校として**、どのコンテンツが見られているか定量的に知りたい。
- **広告主として**、自社広告の到達数を月次レポートで知りたい。
- **システムとして**、AI の改善（プロンプト・モデル選定）に活用したい。

## 受け入れ条件

- [ ] events テーブル: `id`, `school_id`, `event_type (view/tap/dwell/ask)`, `content_id`, `magic_link_id`, `client_id (cookie)`, `timestamp`, `metadata (jsonb)`, 監査カラム
- [ ] 個人特定情報は記録しない（client_id は cookie の uuid のみ）
- [ ] 集計クエリは BigQuery 連携で時系列ダッシュボード化（[NFR07](../non-functional/NFR07-compliance.md) 文科省報告も同じ経路）
- [ ] イベント送信は beacon API でページ遷移時もロスなく送信
- [ ] LiDAR センサーからの dwell 時間データもこのテーブルに統合（[F12](F12-v1-port.md)）

## 関連

- 前段: [F05](F05-class-magic-link.md), [F06](F06-student-qa.md)
- 後段: [F08 (ダッシュボード)](F08-effect-dashboard.md), [F09 (月次レポート)](F09-monthly-report.md)
- 観測: [NFR04](../non-functional/NFR04-audit-log.md)（events は audit_log とは別、event_type で目的を分離）
- テスト: `__tests__/api/events/`
