# NFR01: 性能

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §5 から分割）
- 関連 ADR: ADR-002 (Cloud Run), ADR-001 (PostgreSQL), ADR-006 (Vercel AI SDK)
- 関連 issue: [#13](https://github.com/cometa-kaito/kimiterrace-v2/issues/13)

## 概要

ユーザー体感性能の保証目標。教員入力 → 即公開 → サイネージ反映 の体験速度が運用満足度の主要因。

## 受け入れ条件

- [ ] API p95 レイテンシ < 500ms（Cloud Run cold start 除く）
- [ ] AI ストリーミング初回トークン < 2 秒（[F03](../functional/F03-ai-structuring.md), [F06](../functional/F06-student-qa.md)）
- [ ] サイネージ画面ロード < 1.5 秒（CDN 経由、[F12](../functional/F12-v1-port.md)）
- [ ] DB クエリ p95 < 100ms（RLS 込み、[NFR03](NFR03-security.md)）
- [ ] 公開からサイネージ反映まで最大 60 秒（CDN キャッシュ TTL）
- [ ] Cloud Run の min-instances=1（critical path のみ）で cold start を回避

## 観測

- Cloud Trace で分散トレース
- Cloud Monitoring で SLO 計測
- [NFR04 (監査ログ)](NFR04-audit-log.md) とは別経路（メトリクスは Cloud Monitoring、監査は DB）

## 関連

- 観測: [ADR-014 (Observability)](../../adr/014-observability.md)
- テスト: `__tests__/perf/`, k6 で負荷テスト
