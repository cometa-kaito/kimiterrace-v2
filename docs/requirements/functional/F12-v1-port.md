# F12: V1 既存機能の移植

- 状態: 実装ほぼ完了（移植コア DONE — 管理UI/サイネージ/広告階層マージ/v1-v2マッピング表/Firestore→PG 移行ジョブ/presence 統合）。残 `[ ]` は firmware 切替・DNS カナリア・Firebase 停止で、いずれも `apps/firmware` 不在 + cutover 運用フェーズ依存 — V1 移植は [#48](https://github.com/cometa-kaito/kimiterrace-v2/issues/48) の sub-Issue 群で実装済
- 関連 ADR: ADR-008 (Next.js Route Handlers), ADR-002 (Cloud Run)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#48](https://github.com/cometa-kaito/kimiterrace-v2/issues/48)
- 関連 discovery: [STATUS.md "V1 棚卸し完了"](../../STATUS.md)

## 概要

旧 Firebase 版で実装済の機能を Next.js 16 + Cloud Run 環境へ移植する。**ゼロから書き直さない**。

## ユーザーストーリー

- **校務管理者として**、現在運用中の管理機能（学校・端末・ユーザー）を Cloud Run 移行後も継続使用したい。
- **生徒として**、サイネージ表示が今と同じ見え方を保ってほしい。

## 移植対象（V1 実装済）

- [x] 管理 UI（学校・コンテンツ・端末・ユーザー）— 実装済（[#142](https://github.com/cometa-kaito/kimiterrace-v2/pull/142)、[#164](https://github.com/cometa-kaito/kimiterrace-v2/pull/164)、[#208](https://github.com/cometa-kaito/kimiterrace-v2/pull/208)、`apps/web/app/admin/`：school/system/schools/system/users/contents/editor 一式）
- [x] サイネージ表示エンジン（`management/src/components/signage/` 一式 → `apps/web` 内に Server Component として）— 実装済（[#182](https://github.com/cometa-kaito/kimiterrace-v2/pull/182)、[#238](https://github.com/cometa-kaito/kimiterrace-v2/pull/238)、`apps/web/app/(signage)/`、`apps/web/lib/signage/`）
- [x] 広告階層マージロジック（system → school → class の優先度マージ）— 実装済（[#130](https://github.com/cometa-kaito/kimiterrace-v2/pull/130)、`packages/db/src/schema/effective-ads-view.ts`：`effective_ads_per_class` security_invoker VIEW、`getEffectiveAdsForClass` で scope_rank マージ）
- [x] ~~LiDAR センサー連携（滞留時間取得）~~ **→ Deprecated**。来場検知は [F13](F13-presence-sensor-webhook.md) / [ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) の SwitchBot Webhook 方式に置き換え。自作 LiDAR 案（VL53L8CX + ESP32）は `apps/firmware/` 想定だったが本 MVP では実装しない — 置換先（SwitchBot Webhook 受信基盤）実装済（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)、[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)）。管理 UI 等の残は F13 で追跡
- [ ] firmware の API エンドポイント切替（旧 Firebase Functions → Cloud Run）— 未実装（`apps/firmware/` は不在。CLAUDE.md 構成に予約のみ、§22 で自作 firmware は MVP 非実装と明記）

## 新規追加（V1 未実装）

- [~] QR / タップ / 滞留計測 UI（V1 ではバックエンドに記録するだけだった）— 部分実装（[#182](https://github.com/cometa-kaito/kimiterrace-v2/pull/182)、`apps/web/app/(signage)/signage/[classToken]/_components/SignageClient.tsx`：広告タップ→`type:"tap"` テレメトリ）残: QR コード UI 未実装、滞留(dwell) は F13 presence へ置換
- [x] 広告主エンティティ（V1 では学校マスタに混ざっていた）→ [F10](F10-crm.md) で吸収 — 実装済（[#270](https://github.com/cometa-kaito/kimiterrace-v2/pull/270)、`apps/web/app/admin/system/advertisers/`、`packages/db/src/schema/advertisers.ts`：独立した cross-tenant 広告主マスタ + CRUD）

## 受け入れ条件

- [x] 旧 management/src の各画面と V2 画面の機能等価性を「画面マッピング表」として `docs/architecture/v1-v2-mapping.md` に記録 — 実装済（[#108](https://github.com/cometa-kaito/kimiterrace-v2/pull/108)、`docs/architecture/v1-v2-mapping.md`：V1→V2 ルート対応表 + sub-Issue #48-A〜O 分割）
- [ ] firmware から V2 API への切替は段階的（DNS で 5% → 50% → 100%）— 未実装（firmware 不在 + DNS カナリア切替は cutover 運用タスク。`docs/runbooks/cutover.md` 参照）
- [x] ~~LiDAR データは F07 のイベントログに統合（`event_type='dwell'`）~~ **→ Deprecated**。PIR 由来の `event_type='presence'` で統合（[F13](F13-presence-sensor-webhook.md)）。`dwell` 列挙値はスキーマに保持するが Phase 2 まで書き込み無し — 実装済（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)、[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`packages/db/src/_shared/enums.ts`：eventType に presence 追加・dwell 保持、`packages/db/src/queries/sensor-presence.ts` で presence 書込・dwell 未書込）
- [ ] 旧 Firebase Hosting / Functions は移行完了確認後に停止（[docs/runbooks/cutover.md](../../runbooks/cutover.md)）— 未実装（cutover 運用タスク。データ移行ジョブ `apps/jobs/src/migration/firestore-to-pg.ts` [#151](https://github.com/cometa-kaito/kimiterrace-v2/pull/151) は実装済だが、本条件は「停止」操作そのものを指し未実施）

## 関連

- 前段: 全機能（V1 移植は基盤）
- 後段: [F07](F07-event-logging.md)（イベント統合）, [F10](F10-crm.md)（広告主分離）, [F13](F13-presence-sensor-webhook.md)（来場検知の現行方式）
- 移行: [docs/runbooks/cutover.md](../../runbooks/cutover.md)
- テスト: `__tests__/migration/v1-parity/`, `__tests__/e2e/signage-display/`
