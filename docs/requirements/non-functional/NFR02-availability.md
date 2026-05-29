# NFR02: 可用性

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5 から分割）
- 関連 ADR: ADR-002 (Cloud Run), ADR-001 (PostgreSQL HA)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)

## 概要

公立校の運用時間（平日 7:00-19:00）に確実に稼働すること。

## 受け入れ条件

- [ ] SLA 99.5%（月間ダウンタイム 3.6h 以内、計画メンテ除く）
- [ ] 全クリティカルパスに Cloud Run の min-instances=1
- [ ] Cloud SQL は HA 構成（regional, automatic failover）
- [ ] 計画メンテは平日業務時間外（休日 or 夜間）
- [ ] サイネージ表示は CDN キャッシュで API 障害時も最大 60 秒は表示継続
- [ ] firmware は localStorage に直近 1 日分のサイネージデータをキャッシュし、API 断時も継続表示

## 関連

- 観測: [ADR-014 (Observability)](../../adr/014-observability.md)
- インシデント: [docs/runbooks/incident-response.md](../../runbooks/incident-response.md)
- テスト: `__tests__/chaos/`（chaos engineering、Phase 開発後半）
