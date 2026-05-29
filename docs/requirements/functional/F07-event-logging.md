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
- [ ] **来場検知センサーは PIR 方式の Webhook 受信に切替済**（[F13](F13-presence-sensor-webhook.md) / [ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md)）。`event_type='presence'` を新規追加し、旧 LiDAR 由来の `dwell` とは別物として扱う（PIR は瞬間検知、dwell は継続滞在）
- [ ] `dwell` event_type は Phase 2 で滞留秒数の厳密計測手段が決まるまで使用しない（enum 値は保持、書き込みハンドラは不在で OK）

## 関連

- 前段: [F05](F05-class-magic-link.md), [F06](F06-student-qa.md)
- 後段: [F08 (ダッシュボード)](F08-effect-dashboard.md), [F09 (月次レポート)](F09-monthly-report.md)
- 観測: [NFR04](../non-functional/NFR04-audit-log.md)（events は audit_log とは別、event_type で目的を分離）
- テスト: `__tests__/api/events/`
