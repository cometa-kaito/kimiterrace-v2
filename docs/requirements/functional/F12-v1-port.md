# F12: V1 既存機能の移植

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-008 (Next.js Route Handlers), ADR-002 (Cloud Run)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)
- 関連 discovery: [STATUS.md "V1 棚卸し完了"](../../STATUS.md)

## 概要

旧 Firebase 版で実装済の機能を Next.js 16 + Cloud Run 環境へ移植する。**ゼロから書き直さない**。

## ユーザーストーリー

- **校務管理者として**、現在運用中の管理機能（学校・端末・ユーザー）を Cloud Run 移行後も継続使用したい。
- **生徒として**、サイネージ表示が今と同じ見え方を保ってほしい。

## 移植対象（V1 実装済）

- [ ] 管理 UI（学校・コンテンツ・端末・ユーザー）
- [ ] サイネージ表示エンジン（`management/src/components/signage/` 一式 → `apps/web` 内に Server Component として）
- [ ] 広告階層マージロジック（system → school → class の優先度マージ）
- [ ] ~~LiDAR センサー連携（滞留時間取得）~~ **→ Deprecated**。来場検知は [F13](F13-presence-sensor-webhook.md) / [ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) の SwitchBot Webhook 方式に置き換え。自作 LiDAR 案（VL53L8CX + ESP32）は `apps/firmware/` 想定だったが本 MVP では実装しない
- [ ] firmware の API エンドポイント切替（旧 Firebase Functions → Cloud Run）

## 新規追加（V1 未実装）

- [ ] QR / タップ / 滞留計測 UI（V1 ではバックエンドに記録するだけだった）
- [ ] 広告主エンティティ（V1 では学校マスタに混ざっていた）→ [F10](F10-crm.md) で吸収

## 受け入れ条件

- [ ] 旧 management/src の各画面と V2 画面の機能等価性を「画面マッピング表」として `docs/architecture/v1-v2-mapping.md` に記録（次タスク）
- [ ] firmware から V2 API への切替は段階的（DNS で 5% → 50% → 100%）
- [ ] ~~LiDAR データは F07 のイベントログに統合（`event_type='dwell'`）~~ **→ Deprecated**。PIR 由来の `event_type='presence'` で統合（[F13](F13-presence-sensor-webhook.md)）。`dwell` 列挙値はスキーマに保持するが Phase 2 まで書き込み無し
- [ ] 旧 Firebase Hosting / Functions は移行完了確認後に停止（[docs/runbooks/cutover.md](../../runbooks/cutover.md)）

## 関連

- 前段: 全機能（V1 移植は基盤）
- 後段: [F07](F07-event-logging.md)（イベント統合）, [F10](F10-crm.md)（広告主分離）, [F13](F13-presence-sensor-webhook.md)（来場検知の現行方式）
- 移行: [docs/runbooks/cutover.md](../../runbooks/cutover.md)
- テスト: `__tests__/migration/v1-parity/`, `__tests__/e2e/signage-display/`
