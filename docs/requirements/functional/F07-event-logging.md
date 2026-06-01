# F07: イベントロギング

- 状態: 実装済（コアロギング基盤）— イベント取り込み / beacon 送出 / impression / click-through / presence 統合 / RLS テナント分離テスト（[#258](https://github.com/cometa-kaito/kimiterrace-v2/pull/258)/[#263](https://github.com/cometa-kaito/kimiterrace-v2/pull/263)/[#272](https://github.com/cometa-kaito/kimiterrace-v2/pull/272)/[#312](https://github.com/cometa-kaito/kimiterrace-v2/pull/312)/[#333](https://github.com/cometa-kaito/kimiterrace-v2/pull/333)/[#420](https://github.com/cometa-kaito/kimiterrace-v2/pull/420)）。BigQuery 連携は未実装（PostgreSQL 直集計を F08 で実装）
- 関連 ADR: ADR-014 (Observability), ADR-001 (PostgreSQL)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#43](https://github.com/cometa-kaito/kimiterrace-v2/issues/43)

## 概要

生徒のサイネージ閲覧・タップ・遷移を全て記録。効果可視化と AI 改善の基盤データになる。

## ユーザーストーリー

- **学校として**、どのコンテンツが見られているか定量的に知りたい。
- **広告主として**、自社広告の到達数を月次レポートで知りたい。
- **システムとして**、AI の改善（プロンプト・モデル選定）に活用したい。

## 受け入れ条件

- [~] events テーブル: `id`, `school_id`, `event_type (view/tap/dwell/ask)`, `content_id`, `magic_link_id`, `client_id (cookie)`, `timestamp`, `metadata (jsonb)`, 監査カラム — 部分実装（[#258](https://github.com/cometa-kaito/kimiterrace-v2/pull/258)、`packages/db/src/schema/events.ts`）残: 実装は列名/構成が仕様文面と乖離（`occurred_at`／`payload (jsonb)`／`user_id`、`client_id` は payload 内の匿名 uuid、`presence` を enum 追加、`magic_link_id` 専用列は無し）。仕様文を実装に合わせて書き換えるか要判断
- [x] 個人特定情報は記録しない（client_id は cookie の uuid のみ）— 実装済（[#258](https://github.com/cometa-kaito/kimiterrace-v2/pull/258)、`apps/web/lib/signage/event-ingest.ts`：payload allowlist=clientId/slotIndex/adId、clientId は UUID_RE 強制の匿名 uuid のみ）
- [ ] 集計クエリは BigQuery 連携で時系列ダッシュボード化（[NFR07](../non-functional/NFR07-compliance.md) 文科省報告も同じ経路）— 未実装（BigQuery 連携はコード/依存に無し。時系列集計は PostgreSQL 直集計で F08 側に実装済 `packages/db/src/queries/event-stats.ts` だが BigQuery 経路ではない）
- [x] イベント送信は beacon API でページ遷移時もロスなく送信 — 実装済（[#263](https://github.com/cometa-kaito/kimiterrace-v2/pull/263)、[#333](https://github.com/cometa-kaito/kimiterrace-v2/pull/333)、`apps/web/lib/signage/event-beacon.ts`：`navigator.sendBeacon` 優先 + fetch keepalive フォールバック、adId 実在照合 [#272](https://github.com/cometa-kaito/kimiterrace-v2/pull/272)）
- [x] **来場検知センサーは PIR 方式の Webhook 受信に切替済**（[F13](F13-presence-sensor-webhook.md) / [ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md)）。`event_type='presence'` を新規追加し、旧 LiDAR 由来の `dwell` とは別物として扱う（PIR は瞬間検知、dwell は継続滞在）— 実装済（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400) enum 追加、[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410) presence 書込、`packages/db/src/_shared/enums.ts`／`packages/db/src/queries/sensor-presence.ts`）
- [x] `dwell` event_type は Phase 2 で滞留秒数の厳密計測手段が決まるまで使用しない（enum 値は保持、書き込みハンドラは不在で OK）— 実装済（[#258](https://github.com/cometa-kaito/kimiterrace-v2/pull/258)、`apps/web/lib/signage/event-ingest.ts`：ACCEPTED_TYPES=["view","tap"] で dwell/ask は書込み不在、enum 値は保持、集計も dwell 除外）

> 補足: events テーブルの RLS テナント分離（越境 read/write/insert/update/delete）の実 PG テストは [#420](https://github.com/cometa-kaito/kimiterrace-v2/pull/420)（`packages/db/__tests__/rls/events-tenant-isolation.test.ts`、policy は `0002_rls_policies.sql`）で担保。

## 関連

- 前段: [F05](F05-class-magic-link.md), [F06](F06-student-qa.md)
- 後段: [F08 (ダッシュボード)](F08-effect-dashboard.md), [F09 (月次レポート)](F09-monthly-report.md)
- 観測: [NFR04](../non-functional/NFR04-audit-log.md)（events は audit_log とは別、event_type で目的を分離）
- テスト: `__tests__/api/events/`
