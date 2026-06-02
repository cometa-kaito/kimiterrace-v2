# F13: 来場検知センサー Webhook 受信 + 集計 + UI

- 状態: バックエンド実装済 / UI 未着手 — データモデル（sensor_devices）・Webhook 受信・events presence 統合・F08 在室表示・RLS/Webhook テストは DONE。残: `/admin/sensors` 管理画面・失敗ビュー・`sensor_webhook_failures` テーブル・F08 5/15分ヒートマップ・F09 レポート節（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)/[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)/[#420](https://github.com/cometa-kaito/kimiterrace-v2/pull/420)/[#425](https://github.com/cometa-kaito/kimiterrace-v2/pull/425)/[#432](https://github.com/cometa-kaito/kimiterrace-v2/pull/432)/[#435](https://github.com/cometa-kaito/kimiterrace-v2/pull/435)）
- 関連 ADR: [ADR-020 (SwitchBot Webhook)](../../adr/020-presence-sensor-switchbot-webhook.md), [ADR-001 (PostgreSQL)](../../adr/001-postgres-vs-firestore.md), [ADR-019 (RLS 二層)](../../adr/019-rls-two-layer-tenant-isolation.md)
- 関連要件: [F07 (イベントログ)](F07-event-logging.md), [F08 (効果ダッシュボード)](F08-effect-dashboard.md), [F09 (月次レポート)](F09-monthly-report.md), [F12 (V1 機能移植)](F12-v1-port.md), [NFR03 (セキュリティ)](../non-functional/NFR03-security.md), [NFR04 (監査ログ)](../non-functional/NFR04-audit-log.md)
- 関連 issue: [#391](https://github.com/cometa-kaito/kimiterrace-v2/issues/391), [#408](https://github.com/cometa-kaito/kimiterrace-v2/issues/408)

## 概要

教室に設置した **SwitchBot 人感センサー（PIR 方式）** が SwitchBot Hub 2 経由でクラウドに送信した検知イベントを、本サービス（apps/web 上の Webhook ハンドラ）が受信し、events テーブルへ正規化して保存する。
取り込んだデータは効果ダッシュボード（F08）と月次レポート（F09）から「時間帯別の来場検知回数」「曜日別ピーク」「センサ稼働ヘルス」として参照される。

旧構想では VL53L8CX × 4 + ESP32 × 4 の自作 LiDAR を `apps/firmware/` 内に搭載する想定（F12）だったが、PoC リードタイム・保守負荷・第三者ハードウェアリスクから **SwitchBot Webhook 方式に切替**（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md)）。
本 F13 はその切替後の取り込み口・データモデル・UI を規定する。

## ユーザーストーリー

- **校務管理者として**、教室のどの時間帯に生徒の往来が多いか、サイネージ運用前提の数値で知りたい。
- **システム管理者として**、広告主月次レポート（F09）に「想定接触機会数（時間帯別）」を客観データとして掲載したい。
- **教員として**、自分の連絡コンテンツが配信されていた時間帯に教室に何人いたかの目安を、後追いでフィードバックされたい。
- **システム管理者として**、設置したセンサが「いつ最後に応答したか」「電池切れの疑いはないか」を運用画面で一望したい。
- **広告主（システム外）として**、月次レポートに記載される接触機会数の根拠が「カメラを使わない、個人を識別しないセンサ」であることを明示されたい（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) 公開文言）。

## 受け入れ条件

### 1. データモデル

- [x] 新規テーブル `sensor_devices`（school_id × device_mac でユニーク、auditColumns 必須、RLS 有効）— 実装済（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)、`packages/db/src/schema/sensor-devices.ts`：device_mac はグローバル UNIQUE で webhook 解決をテナント安全化、auditColumns、RLS は `migrations/0014_sensor_devices_rls.sql`）
  - `id`, `school_id (FK)`, `device_mac`, `device_id_external`, `vendor`（enum: `switchbot`）, `kind`（enum: `presence_pir`）, `location_label`（教室名等の自由文字列、PII を含めない）, `class_id (FK, nullable)`, `installed_at`, `decommissioned_at (nullable)`, 監査カラム
- [x] events 拡張: `event_type` 列挙に `presence` を追加（既存 `view/tap/dwell/ask` を変更しない）— 実装済（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)、`packages/db/src/_shared/enums.ts`：eventType=["view","tap","dwell","ask","presence"]、末尾追加で非破壊。payload 規約は `sensor-presence.ts` で実装）
  - **`presence` と `dwell` の区別**: PIR は「動きの瞬間検知」であり、「滞在秒数」は計測しない。`dwell` は LiDAR/カメラ等の継続滞在時間用途として将来枠で残す。F07 参照
  - `payload (jsonb)` 規約: `{ device_mac, detection_state ("DETECTED"|"NOT_DETECTED"), detected_at_ms, event_version, raw }`
  - `school_id` は `sensor_devices.school_id` から解決（webhook には school_id が直接来ないため）。device_mac → school_id 解決失敗時は events に書き込まず `webhook_failures` 系の `unknown_device` として記録（NFR04 監査）
- [ ] 取り込み失敗ログ用 `sensor_webhook_failures` テーブル（auditColumns 必須、RLS は schoolId nullable のため特例で `system_admin_only`）— 未実装（スキーマ未定義。Webhook ハンドラは失敗時に 200/500 を返すのみで失敗行を退避しない）
  - `id`, `reason`, `raw_payload (text)`, `received_at`, `school_id (nullable, 解決できた場合のみ)`, 監査カラム
- [~] migrations は drizzle-kit 生成のみ。手書き SQL 禁止（[CLAUDE.md ルール 3](../../../CLAUDE.md)）— 部分実装（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)、`packages/db/drizzle/20260601064358_f13_sensor_devices.sql`）残: RLS/循環 FK の後付けは手書き `migrations/0014_sensor_devices_rls.sql`（既存 audit/RLS と同パターンの確立例外）

### 2. Webhook 受信エンドポイント `POST /api/sensors/switchbot/webhook`

- [x] 認可: 共有シークレットを URL `?key=…` または `X-Webhook-Key` ヘッダで受け取り、Secret Manager から取得した値と定数時間比較 — 実装済（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`apps/web/app/api/sensors/switchbot/webhook/route.ts`、`apps/web/lib/sensors/webhook-secret.ts`：`x-webhook-key` ヘッダ→`?key=` フォールバック、`verifyWebhookSecret` で定数時間比較、`getConfiguredWebhookSecret` で fail-closed）
  - Secret 名: `switchbot-webhook-key`（[CLAUDE.md ルール 5](../../../CLAUDE.md)）
- [~] レート制限: 1 device_mac あたり 5 秒間隔以上の発火を期待。ただし短時間連続発火も DoS にならぬよう、ハンドラ内で SLO 内処理（p95 < 200ms）を守る（NFR01）— 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、[#436](https://github.com/cometa-kaito/kimiterrace-v2/pull/436) メモリ境界化、`apps/web/lib/sensors/rate-limit.ts`）残: レート制限キーは device_mac 単位でなく IP（client key）単位。冪等 dedup は `sensor-presence.ts`（device_mac+occurred_at）で別途担保
- [~] バリデーション: zod スキーマ（drizzle-zod 由来）で payload 検証。失敗時は `sensor_webhook_failures` に書き込み、200 OK を返す（SwitchBot 側のリトライ嵐回避）— 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`apps/web/lib/sensors/switchbot.ts`：`parsePresenceWebhook`→失敗で 200 返却）残: 失敗時の `sensor_webhook_failures` 書込なし（退避先テーブルが未実装）
- [~] 解決: `device_mac → sensor_devices.school_id` を取得。未登録なら失敗テーブルに `unknown_device` で退避（events には書かない）— 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`packages/db/src/queries/sensor-presence.ts`：system_admin context 経由の cross-tenant 解決、未登録は events に書かず `{status:"unknown_device"}` 返却）残: 未登録時の失敗テーブル退避なし
- [~] 監査: events への書き込みは audit_log で trail（NFR04 のハッシュチェーン）。`created_by` はサービスアカウント `system://switchbot-webhook` — 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`packages/db/src/queries/sensor-presence.ts`：events と同 tx の audit_log INSERT + トリガがハッシュチェーン計算）残: actor は `system://switchbot-webhook` 文字列でなく null（system actor）
- [~] RLS: webhook ハンドラはサービスロールセッションで動作するが、events INSERT 前に `SET LOCAL app.current_school_id`／`app.current_user_role='system_service'` を明示 — 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`packages/db/src/queries/sensor-presence.ts`：`withTenantContext(db,{role:"system_admin"})` + `set_config('app.current_school_id', …)` を INSERT 前に明示）残: role 値は仕様の `system_service` でなく既存 `system_admin`（ADR-019 二層 RLS の system_admin_full_access policy 利用）
- [ ] Sentry: 解決失敗・スキーマ失敗・DB 例外を `level=warning` 以上で送信、PII は payload マスクして送る（[ADR-013](../../adr/013-sentry.md)）— 未実装（route/`sensor-presence.ts` に Sentry 連携なし。解決失敗は status 返却、例外は 500 返却のみ）

### 3. Web UI（system_admin / school_admin 向け）

#### 3.1 センサー管理画面 `/admin/sensors`

- [~] 一覧（school_admin は school_id スコープ、system_admin は全件 + school フィルタ）— 部分実装（`apps/web/app/admin/sensors/page.tsx` + `packages/db` `listSensorDevices`：school_admin/teacher の**自校スコープ読み取り一覧**を実装。RLS（`tenant_isolation`）委譲でテナント分離、device_mac はマスク表示、設置場所/種別/稼働・撤去状態/最終検知時刻を表示。実 PG RLS テスト `packages/db/__tests__/rls/sensor-list.test.ts`）残: system_admin の全校横断ビュー + school フィルタ、紐づくクラス名・24h 検知数列、稼働ステータス自動分類（後述）は未実装
  - 列: 設置場所ラベル / 紐づくクラス / device_mac（マスク表示） / 直近検知時刻 / 24h 検知数 / 稼働ステータス（後述）
- [ ] 詳細 / 編集: location_label, class_id, 設置/撤去日 — 未実装（`/admin/sensors` ルート不在）
- [ ] 新規登録フォーム: device_mac は SwitchBot 開発者画面の表記（コロン区切り）を許容しつつ、内部では正規化（小文字 + コロンなし）して保存 — 未実装（登録 UI/Server Action 不在。受信側の MAC 正規化は `sensor-presence.ts` に存在するが大文字正規形で照合用）
- [ ] 稼働ステータス分類（表示用）: — 未実装（healthy/quiet/dead 判定ロジック・サーバ集約が不在）
  - `🟢 healthy`：直近 24h 以内に検知あり
  - `🟡 quiet`：24h 検知なしだが 7 日以内に検知あり（夏休み・休日等のグレーゾーン）
  - `🔴 dead`：7 日以上検知なし
  - 判定ロジックはサーバ側（apps/web の Route Handler）に集約。UI は色 + テキスト両方で示すこと（[NFR05](../non-functional/NFR05-accessibility.md) 色だけに依存しない）
- [ ] 編集・新規・撤去は全て audit_log 対象（NFR04）— 未実装（管理操作 UI/Action が無いため対象操作自体が不在）

#### 3.2 効果ダッシュボード拡張（F08 への追記要件）

- [~] 時間帯別ヒートマップ（5 分 or 15 分バケット × 平日/休日）— 部分実装（[#432](https://github.com/cometa-kaito/kimiterrace-v2/pull/432)、`apps/web/app/admin/dashboard/page.tsx`：hour-of-day の CSS バー `PresenceTrend` + `getHourlyPresenceCounts`）残: 5/15 分バケット × 平日/休日のヒートマップは未着手
  - データ源: `events WHERE type='presence' AND detection_state='DETECTED'`
  - school_id スコープは RLS で強制（[ADR-019](../../adr/019-rls-two-layer-tenant-isolation.md)）
- [~] センサー別の日次推移グラフ（折れ線、Recharts ([F08](F08-effect-dashboard.md))）— 部分実装（[#435](https://github.com/cometa-kaito/kimiterrace-v2/pull/435)、`apps/web/app/admin/dashboard/page.tsx`：学校集計の日次推移 `DailyPresenceTrend` を CSS バーで実装）残: センサー別内訳・Recharts 折れ線は未実装（Recharts/Visx は意図的に不採用）
- [x] 「カメラ非使用」バッジを常時表示（[ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md) 透明性要件）— 実装済（[#432](https://github.com/cometa-kaito/kimiterrace-v2/pull/432)、`apps/web/app/admin/dashboard/page.tsx`：「カメラ不使用」バッジを title 付きで常時表示）
- [~] WCAG 2.2 AA 準拠（[NFR05](../non-functional/NFR05-accessibility.md)）：色覚バリアフリーの配色、kbd ナビゲーション、ARIA ラベル — 部分実装（[#435](https://github.com/cometa-kaito/kimiterrace-v2/pull/435)、`apps/web/app/admin/dashboard/page.tsx`：在室表示は色 + 件数テキスト併記で色依存回避）残: ヒートマップ未実装ぶんの AA 監査は未完

#### 3.3 月次レポート（F09 への追記要件）

- [ ] レポート PDF に「想定接触機会数（時間帯別）」セクションを追加 — 未実装（`apps/jobs/src/reports/pdf.ts` に presence/接触機会の節なし）
- [ ] 数値の脚注として「人感センサー（PIR 方式）による動き検知回数。個人を識別する情報は含みません。複数人が同時に通過した場合も 1 回として計上されます」を必ず付記 — 未実装（PDF に presence 節が無いため脚注も不在）
- [ ] 検知ゼロが続いていた期間は『計測対象外』としてグラフから除外しつつ、本文に明記 — 未実装（presence のレポート反映自体が未実装）

#### 3.4 取り込み失敗ビュー `/admin/sensors/failures`（system_admin 専用）

- [ ] 直近 30 日の `sensor_webhook_failures` を表示 — 未実装（ルート不在 + `sensor_webhook_failures` テーブル自体が未実装）
- [ ] フィルタ: `reason=unknown_device | invalid_payload | db_error` — 未実装（失敗ビュー不在）
- [ ] 詳細パネルで `raw_payload` を整形表示（PII の混入が無いか目視確認できるように整形）— 未実装（失敗ビュー不在）
- [ ] 1-click で「このデバイスを登録する」ショートカット（device_mac 自動補完）— 未実装（失敗ビュー・登録フォーム共に不在）

### 4. セキュリティ・運用

- [ ] device_mac は擬似識別子として扱い、UI 上は末尾 4 文字のみ平文（例: `…:7F:A2`）。フル値は system_admin の詳細画面のみ — 未実装（device_mac マスク表示を行う UI が未実装）
- [~] Webhook URL に含める共有シークレットは少なくとも 32 byte（base64 で 44 文字以上）。Secret Manager のローテーションは半年に一度（[NFR04](../non-functional/NFR04-audit-log.md) runbook）— 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`apps/web/lib/sensors/webhook-secret.ts`：シークレット取得 + 定数時間比較）残: 最小バイト長(32 byte)の強制検証・半年ローテーション runbook は未確認（強度は運用依存）
- [~] CSRF: 本エンドポイントは外部 origin（SwitchBot）からの POST を受けるため、Next.js の Server Action CSRF と分離して `runtime='nodejs'` の Route Handler に置く — 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`apps/web/app/api/sensors/switchbot/webhook/route.ts`：Server Action と分離した Route Handler + 共有シークレット認可）残: `export const runtime='nodejs'` の明示なし
- [x] SwitchBot 側の IP/ホスト名は安定保証がないため、IP allowlist に依存しない設計（共有シークレット強度で担保）— 実装済（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`apps/web/app/api/sensors/switchbot/webhook/route.ts`：認可は共有シークレットのみで IP allowlist 非依存）
- [ ] 観測: 直近 1h で `unknown_device` が一定数を超えたら Sentry に warning（誤接続 or 攻撃の予兆検知）— 未実装（閾値監視・Sentry warning 連携なし）

### 5. テスト

- [~] `__tests__/api/sensors/webhook/`（ハンドラ）— 部分実装（[#410](https://github.com/cometa-kaito/kimiterrace-v2/pull/410)、`apps/web/__tests__/api/sensors-webhook.api.test.ts`：正常→recordPresenceEvent / key 不一致→401 / 不正 JSON→200 / 未知→200。実 PG の INSERT/audit は `packages/db/__tests__/rls/sensor-webhook-ingest.test.ts`）残: failures 行は未実装ぶん未検証
  - 正常: 既知 device_mac → events INSERT 1 件 + audit_log 1 件
  - 認可: key 不一致 → 401、events 書き込みなし
  - スキーマ失敗: 不正 JSON → 200 + failures 1 件
  - 未知 device_mac → 200 + failures 1 件（events 書き込みなし）
- [x] `__tests__/rls/sensor-devices.test.ts`（[CLAUDE.md ルール 2](../../../CLAUDE.md)）— 実装済（[#400](https://github.com/cometa-kaito/kimiterrace-v2/pull/400)、`packages/db/__tests__/rls/sensor-devices.test.ts`：自校のみ可視 / context 未設定 deny / system_admin 全可視 / cross-tenant 重複 MAC 登録拒否）
  - 自 school_id 行のみ可視 / 他 school_id 不可視 / system_admin 全可視 / 未設定セッション拒否
- [ ] `__tests__/ui/admin-sensors/`（管理画面）— 未実装（管理画面自体が未実装）
  - 健全性ステータス分類のスナップショット
  - school_admin は他校データを参照不可（403）
- [ ] e2e（Playwright）— 未実装（SwitchBot 模擬 POST→統計画面反映の貫通シナリオなし。webhook 単体は `sensor-webhook-ingest.test.ts` 実 PG で検証）
  - SwitchBot 模擬 POST → 統計画面に 1 件反映されるまで（Testcontainers で実 PG 起動 [ADR-012](../../adr/012-testing-stack.md)）

## 関連

- 前段: [F12 (V1 機能移植)](F12-v1-port.md)（自作 LiDAR 構想は ADR-020 で deprecated）
- 後段: [F08 (効果ダッシュボード)](F08-effect-dashboard.md), [F09 (月次レポート)](F09-monthly-report.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [ADR-020](../../adr/020-presence-sensor-switchbot-webhook.md), [ADR-019 (RLS)](../../adr/019-rls-two-layer-tenant-isolation.md)
- 観測: [NFR04 (監査)](../non-functional/NFR04-audit-log.md), [ADR-013 (Sentry)](../../adr/013-sentry.md), [ADR-014 (Observability)](../../adr/014-observability.md)
- テスト: `__tests__/api/sensors/`, `__tests__/rls/sensor-devices.test.ts`, `__tests__/ui/admin-sensors/`

## 旧 LP リファレンス実装（移行元）

PoC 期間中は本 v2 に先行して **別リポジトリ `edix-lp/`（ユーザー手元では `06_LP/edix-lp/` に配置）に Turso（ホスト型 SQLite）で同等機能の素朴版**を 2026-05-29 に投入済み。
v2 への移植時は以下を参照しつつ、本 F13 の規律（RLS、監査、Drizzle、PII マスキング、テスト緑）に従って再実装する:

- `app/api/switchbot-webhook/route.ts` — 受信ハンドラの最小実装
- `app/api/sensor-stats/route.ts` — 確認用 GET の発想
- `lib/sensor-db.ts` — Turso ラッパー（v2 では Drizzle スキーマに置換）
- `migrations/001_init.sql` — events ＋ failures の素朴版
- `docs/SWITCHBOT_SETUP.md` — SwitchBot 側の Webhook 登録手順（v2 でもユーザー手順はほぼ同じ）

PoC 終了後（2026-10-01 以降）、本 F13 に従って v2 側を実装し、データ移行（PoC 期間 Turso → Cloud SQL）を経て **LP 側のエンドポイントは廃止**する。
