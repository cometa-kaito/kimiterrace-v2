# F15: TV デバイスリモート管理基盤（管理画面 + ConfigPoller）

- 状態: 基盤＋ポーリング＋編集＋コマンド queue 実装済 / トークン個別化・オンボーディング UI・監査ビュー・URL 自動抽出は未着手 — レジストリ/RLS・`GET /api/tv/config` ポーリング config（last_seen 心拍 + unknown 応答 + レート制限）・一覧・設定編集（version +1 + 監査 + SSRF ガード）・リモートコマンド queue（enqueue + poll 配信 + ack）は DONE（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)/[#494](https://github.com/cometa-kaito/kimiterrace-v2/pull/494)/[#496](https://github.com/cometa-kaito/kimiterrace-v2/pull/496)/[#497](https://github.com/cometa-kaito/kimiterrace-v2/pull/497)/[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)）。残: `tv_device_tokens` 個別トークン（現状は共通シークレット TV_POLL_SECRET）・新規登録/オンボーディング UI・専用監査ログビュー・signage_url 自動抽出・`events.tv_device_id` 拡張・§3 webhook payload context 拡張
- 関連 ADR: [ADR-020 (SwitchBot Webhook)](../../adr/020-presence-sensor-switchbot-webhook.md), [ADR-022 (TV リモート設定はポーリング方式)](../../adr/022-tv-remote-config-polling.md), [ADR-019 (RLS 二層)](../../adr/019-rls-two-layer-tenant-isolation.md), [ADR-001 (PostgreSQL)](../../adr/001-postgres-vs-firestore.md)
- 関連要件: [F08 (効果ダッシュボード)](F08-effect-dashboard.md), [F11 (ロール管理)](F11-role-management.md), [F12 (V1 機能移植)](F12-v1-port.md), [F13 (来場検知 Webhook)](F13-presence-sensor-webhook.md), [NFR03 (セキュリティ)](../non-functional/NFR03-security.md), [NFR04 (監査ログ)](../non-functional/NFR04-audit-log.md)
- 関連 issue: [#131](https://github.com/cometa-kaito/kimiterrace-v2/pull/131)（要件 + ADR-022）

## 概要

教室に設置された Google TV（自作 Android アプリ `com.kimiterrace.tvbridge` 稼働中）に対し、**学校・現地に物理アクセスせずに** 以下をリモート制御するための基盤と管理 UI を提供する。

- サイネージ URL の変更（教室の所属クラス変更時など）
- スケジュール（曜日・時刻）の変更（学期・行事による運用変更）
- BLE 受信対象センサ MAC の変更（センサ故障で交換した時）
- サイネージのリロード（コンテンツ更新後の即時反映）
- TV ごとの稼働ヘルス確認（最終ポーリング、検知件数）

通信方式は **TV からのポーリング**（pull）。push 型（WebSocket/FCM）は NAT・ファイアウォール越え・接続維持コストの観点で却下（ADR-022 で記録）。

PoC 期間中（2026-06-01〜09-30）は LP リポジトリ（`edix-lp`）に Turso で素朴版を 2026-05-30 に投入済。v2 では Cloud SQL + Drizzle + RLS + 監査カラム + UI 統合の正式版として再実装する。

## ユーザーストーリー

- **システム管理者として**、各 TV のサイネージ URL を学校に行かずに変更したい（クラス再編、サイネージ自体の URL 構造変更への追従）。
- **システム管理者として**、スケジュール（ON/OFF 時刻・曜日マスク）を一括で変更したい（行事日程、長期休業対応）。
- **システム管理者として**、特定 TV のサイネージを今すぐリロードしたい（教員からの「画面が固まっている」報告に即応）。
- **校務管理者（school_admin）として**、自校の TV のスケジュールだけは変更したい（権限分離）。
- **システム管理者として**、各 TV の最終ポーリング時刻を見て稼働ヘルス（🟢/🟡/🔴）を判断したい。
- **システム管理者として**、新しい教室に TV を追加する時は signage URL を入力するだけで自動的に school/grade/department/class を抽出して登録したい。

## 受け入れ条件

### 1. データモデル

- [x] 新規テーブル `tv_devices`（school_id でテナント分離、auditColumns 必須、RLS 有効）— 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`packages/db/src/schema/tv-devices.ts`：device_id（グローバル一意）/label/school_id/grade_id/department_id/class_id/target_mac/signage_url/webhook_url/schedule_json/version/last_seen_at/last_known_ip/notes/deleted_at + auditColumns。RLS は `migrations/0016_tv_devices_rls.sql`。※ last_known_ip は inet でなく varchar で実装）
  - `id` (uuid, PK), `device_id` (text, 一意, TV が初回起動時生成する UUIDv4)
  - `label` (text, "電子工学科 1年" 等の表示用)
  - `school_id (FK)`, `grade_id (FK, nullable)`, `department_id (FK, nullable)`, `class_id (FK, nullable)`
  - `target_mac` (text, BLE スキャン対象センサ MAC)
  - `signage_url` (text)
  - `webhook_url` (text)
  - `schedule_json` (jsonb)
  - `version` (int, monotonic, 設定変更のたび +1)
  - `last_seen_at` (timestamptz, TV からの最終ポーリング)
  - `last_known_ip` (inet, nullable)
  - `notes` (text, nullable)
  - `deleted_at` (timestamptz, nullable, ソフトデリート用 / §4.2)
  - 監査カラム
- [x] 新規テーブル `tv_device_commands`（コマンドキュー、send-once セマンティクス）— 実装済（[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)、`packages/db/src/schema/tv-device-commands.ts`：device_id/school_id/command(enum signage_reload/open/exit/service_restart)/params_json/issued_by/issued_at/acknowledged_at/status(enum pending/delivered/failed/expired) + auditColumns。RLS は `migrations/0019_tv_device_commands_rls.sql`。pending→delivered の冪等 ack）
  - `id` (uuid), `device_id` (FK to tv_devices.device_id)
  - `school_id` (FK, RLS テナント分離用。`tv_devices.school_id` から継承して INSERT)
  - `command` (enum: `signage_reload`, `signage_open`, `signage_exit`, `service_restart`)
  - `params_json` (jsonb, nullable)
  - `issued_by` (FK to users)
  - `issued_at`, `acknowledged_at` (TV が受信した時刻)
  - `status` (enum: `pending`, `delivered`, `failed`, `expired`)
  - 監査カラム（RLS 有効）
- [ ] 新規テーブル `tv_device_tokens`（TV ごとのポーリング認証トークン、§2/§5）— 未実装（TV 個別トークン表は未定義。現状は共通シークレット `TV_POLL_SECRET`（`apps/web/lib/tv/poll-secret.ts`、Secret Manager 経由）で認可。本 doc §2 が「初期は共通シークレットでも可、Phase 2 で TV 個別」を許容する範囲内の未着手）
  - `id` (uuid, PK), `device_id` (FK to tv_devices.device_id)
  - `school_id` (FK, RLS テナント分離用)
  - `token_hash` (text, 生トークンは保存せずハッシュのみ。生値は登録直後 1 度だけ平文表示)
  - `expires_at` (timestamptz, nullable, 半年ローテーション / 紛失時即時失効用)
  - `revoked_at` (timestamptz, nullable)
  - 監査カラム（RLS 有効）
- [~] TV 設定変更は対象テーブル（`tv_devices` / `tv_device_commands` / `tv_device_tokens`）への操作として既存 `audit_log` に記録（`table_name` + `record_id` + `operation`(insert/update/delete) + `diff`。`audit_log` に `type` 列はないため、新規テーブルも新規列も作らず NFR04 のハッシュチェーンにそのまま寄せる）— 部分実装（[#494](https://github.com/cometa-kaito/kimiterrace-v2/pull/494)：設定編集が既存 `audit_log` に記録、[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)：コマンド発行も監査同梱）残: `tv_device_tokens` は表自体が未実装のため対象外
  - 「誰がいつどのフィールドをどう変更したか」を全件残す（NFR04）
- [ ] `events` 拡張（F13 の来場イベントテーブル。`motion_events` ではない）: `tv_device_id` (FK to tv_devices.device_id, nullable) を追加 — 未実装（`packages/db/src/schema/tv-devices.ts` のコメントに「将来 `events.tv_device_id` で紐付ける拡張は F15 §1 にあるが本基盤スライス非スコープ」と明記。events スキーマに列追加なし）
  - 既存の `presence` イベントが TV 経由で来た場合はこの列に紐付ける
  - 直接 SwitchBot クラウド経由（F13）の場合は NULL（device_mac で別途解決）
- [x] テーブル DDL は drizzle-kit 生成（手書き DDL 禁止、[CLAUDE.md ルール 3](../../../CLAUDE.md)）。RLS / ポリシー / トリガ等 drizzle-kit が扱えない要素は `packages/db/migrations/000N_*.sql` の手書き SQL で適用し、`__tests__/_setup/global-setup.ts` のローダ配列に登録する（既存 0001〜0007 と同方式）— 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)/[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)、DDL は `drizzle/20260602024915_f15_tv_devices.sql`、RLS は `migrations/0016`・`0019`、auto-discovery loader に乗る）

### 2. TV → サーバ ポーリング API `GET /api/tv/config`

- [x] URL: `GET /api/tv/config?device_id=<uuid>&key=<token>` — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/app/api/tv/config/route.ts`：`runtime='nodejs'` の Route Handler、`?key=` / `x-tv-key` ヘッダ受付）
- [~] 認可: `key` は `tv_device_tokens` テーブルで TV ごとに発行（初期は共通シークレットでも可、Phase 2 で TV 個別）。Secret Manager 管理（[CLAUDE.md ルール 5](../../../CLAUDE.md)）— 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/lib/tv/poll-secret.ts`：共通シークレット `TV_POLL_SECRET` を Secret Manager 経由で取得・定数時間比較・未設定は fail-closed 401）残: `tv_device_tokens` での TV 個別発行は Phase 2（本 doc 許容範囲の「初期は共通シークレット」段階）
- [ ] レスポンス（device_id 一致時）:
  ```json
  {
    "version": 5,
    "config": {
      "target_mac": "DC:A5:B3:C2:98:D7",
      "signage_url": "https://app.school-signage.net/?...",
      "webhook_url": "https://.../api/sensors/switchbot/webhook?key=...",
      "schedule": { "enabled": true, "on_hour": 7, ... },
      "device_label": "電子工学科 1年"
    },
    "commands": { "signage_reload": false, ... }
  }
  ```
- [x] 副作用: `tv_devices.last_seen_at` を `now()` で更新、`last_known_ip` を `x-forwarded-for` 由来で更新 — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`packages/db/src/queries/tv-devices.ts` `pollTvConfig`：cross-tenant 解決 + last_seen_at/last_known_ip を 1 文で原子更新。IP は route の XFF 由来）
- [x] ポーリング間隔: TV 側は 60秒（変更は将来のリモート設定で）— 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、サーバ側 ADR-022 で 60 秒間隔を前提。TV 側 `ConfigPoller.kt` は LP リポジトリ実装）
- [x] レート制限: 1 device_id あたり 1分5リクエスト（DoS 抑止、[NFR01](../non-functional/NFR01-performance.md)）— 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/lib/tv/rate-limit.ts` `tvPollRateLimiter`：device_id 単位 1 分 5 回、超過は 429 + Retry-After。NAT 共有 IP でも device 単位で独立）
- [x] device_id が tv_devices に未登録の場合は `{"unknown": true, "version": 0}` を返し、UI 側で「未登録 TV のポーリングを検出」として通知 — 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`pollTvConfig` が未登録 device_id に `{unknown:true, version:0}` を返却。UI 側の「未登録ポーリング検出」通知は未実装だが応答仕様自体は完了）

### 3. TV → サーバ POST ペイロード拡張（F13 の Webhook 受信側に既存）

- [ ] `POST /api/sensors/switchbot/webhook` の payload.context に以下のフィールドを受け入れる: — 未実装（F13 の `apps/web/lib/sensors/switchbot.ts` の payload パーサに TV コンテキスト（tv_device_id 等）の受け入れなし）
  - `tv_device_id`, `school_id`, `grade_id`, `department_id`, `class_id`, `device_label`
- [ ] `events`（F13 の来場イベントテーブル）に上記コンテキストを保存 — 未実装（`events.tv_device_id` 列自体が未追加（§1 参照）のため保存先がない）
- [ ] device_mac から sensor_devices.school_id への解決と、ペイロードの school_id が一致しない場合は警告ログ（[NFR04](../non-functional/NFR04-audit-log.md)）— 未実装（webhook はペイロード school_id を受け取らず device_mac のみで解決するため不一致検査が不在）

### 4. Web 管理 UI `/admin/tv-devices`

#### 4.1 一覧画面

- [~] school_admin は school_id スコープ、system_admin は全件 + school フィルタ — 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/app/admin/tv-devices/page.tsx` + `listTvDevices`：school_admin=自校 / system_admin=全件 を RLS 委譲で実現。実 PG RLS テスト `packages/db/__tests__/rls/tv-devices.test.ts`）残: system_admin 向けの school フィルタ UI は未実装
- [~] 列: 教室ラベル / school/grade/department/class / target_mac（マスク） / 直近検知時刻 / 24h 検知数 / 最終ポーリング時刻 / 稼働ステータス — 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、ラベル / target_mac マスク（末尾4桁）/ 最終ポーリング時刻 / 稼働ステータスを表示）残: grade/department/class 名・直近検知時刻・24h 検知数の列は未実装（presence 連携が §3 未着手）
- [~] 稼働ステータス判定: — 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/lib/tv/status.ts` `classifyTvLiveness`（サーバ側純関数）で `last_seen_at` 鮮度から判定、UI は色 + テキスト両方）残: 「直近 1h 検知あり」条件は presence 連携（§3）未着手のため未反映。F16 §5 で閾値を online/quiet/down に統一済（後述）
  - `🟢 healthy`: last_seen_at が 5分以内 AND 直近 1h 検知あり
  - `🟡 quiet`: last_seen_at が 1時間以内（OFF期間中は許容）
  - `🔴 unreachable`: last_seen_at が 1時間以上前
  - 判定ロジックはサーバ側（Route Handler）に集約、UI は色 + テキスト両方（[NFR05](../non-functional/NFR05-accessibility.md)）

#### 4.2 詳細・編集画面

- [x] label / signage_url / target_mac / schedule の編集 — 実装済（[#494](https://github.com/cometa-kaito/kimiterrace-v2/pull/494)、`apps/web/app/admin/tv-devices/[deviceId]/edit/page.tsx` + `_components/TvConfigEditForm.tsx` + `lib/tv/config-edit-actions.ts`：label/signage_url/webhook_url/target_mac/schedule/monitoring_enabled を編集。編集は `TV_CONFIG_EDIT_ROLES`（school_admin/system_admin）限定）
- [ ] signage_url を入力すると **自動的に school/grade/department/class クエリパラメータを抽出** してフィールドに反映（UI 側 JS で自動補完、ユーザー上書き可）— 未実装（`TvConfigEditForm.tsx` に URL クエリパラメータ抽出の自動補完なし。grade/department/class は手動設定）
- [x] 「保存」で `version` を +1、`audit_log` 1 件作成 — 実装済（[#494](https://github.com/cometa-kaito/kimiterrace-v2/pull/494)、`lib/tv/config-edit-actions.ts`：保存で version +1（monotonic）+ 既存 audit_log に記録）
- [x] 「サイネージリロード」ボタン → `tv_device_commands` に `signage_reload` を 1 件 INSERT — 実装済（[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)、`_components/TvCommandControl.tsx` + `lib/tv/command-actions.ts` `enqueueTvCommandAction` → `enqueueTvCommand`（packages/db）で pending を INSERT）
- [x] 「サイネージ強制起動」「サイネージ強制終了」「サービス再起動」も同様にコマンドキューへ — 実装済（[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)、`lib/tv/command-core.ts`：signage_open/signage_exit/service_restart を同 enqueue 経路でキューイング）
- [~] 削除はソフトデリート（`deleted_at` カラム）、復活可能 — 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`deleted_at` 列 + クエリ（`listTvDevices`/`pollTvConfig`/編集）が `deleted_at IS NULL` で退役行を除外）残: 削除（deleted_at セット）・復活を行う UI/Server Action が未実装＝ユーザー操作で削除できない）

#### 4.3 新規登録画面（オンボーディング）

- [ ] system_admin のみ操作可 — 未実装（新規登録/オンボーディング UI（`/admin/tv-devices/new` 等）が不在）
- [ ] 入力: label, school_id, signage_url（残りは URL 自動抽出）, target_mac — 未実装（登録フォーム不在。URL 自動抽出も §4.2 同様未実装）
- [ ] `device_id` は手動入力 or 自動生成（TV からの初回ポーリングで auto-create するパターンも許容）— 未実装（登録フォーム不在。なお `pollTvConfig` は未登録 device_id を auto-create せず unknown 応答する設計）
- [ ] 登録完了後、`tv_device_tokens` を発行して PostgreSQL に保存し、表示（コピーボタン）。以降は再表示不可 — 未実装（`tv_device_tokens` 表が未実装（§1）かつ登録 UI 不在。認可は現状共通シークレット）

#### 4.4 監査ログビュー `/admin/tv-devices/:id/audit`

- [ ] そのデバイスの設定変更履歴を表示（誰がいつ何を変更したか）— 未実装（専用の設定変更 audit ビュー `/admin/tv-devices/:id/audit` は不在。変更は audit_log に記録されるが閲覧 UI 無し。`/admin/tv-devices/:id/history` は F16 のダウンタイム履歴ビューで別物）

### 5. セキュリティ・運用

- [x] `device_id` は推測不能な UUIDv4 — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、device_id は TV 生成 UUIDv4 を text 列でグローバル一意に保持。行参照は別 PK uuid `id` を使用）
- [ ] `tv_device_tokens` は TV ごと発行、ハッシュ化して保存（生トークンは登録直後 1 度のみ表示）— 未実装（トークン表未実装（§1）、現状は共通シークレット）
- [ ] トークンローテーション: 半年ごと、または TV 紛失時は即時失効 — 未実装（TV 個別トークンが無いため失効/ローテーション機構なし。共通シークレットのローテは運用依存）
- [x] device_mac は UI 上は末尾 4 文字のみ平文表示、フル値は system_admin の詳細画面のみ — 部分実装（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`lib/tv/status.ts` `maskMac` で一覧の target_mac を末尾4桁マスク表示）残: system_admin 詳細でのフル値表示は未実装
- [x] CSRF: `/api/tv/config` は外部 origin（TV）からの GET を受けるため、Server Action CSRF から分離して `runtime='nodejs'` の Route Handler に置く — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/app/api/tv/config/route.ts`：`export const runtime='nodejs'` + `dynamic='force-dynamic'`、Server Action と分離した Route Handler）
- [ ] Sentry: 未知の device_id ポーリング、認証失敗、コマンド配信失敗を warning 以上で送信（PII マスク）— 未実装（route に Sentry 連携なし。未登録は unknown 応答、認証失敗は 401 のみ）
- [ ] 観測: 直近 1h で `unknown_device_id` ポーリングが一定数を超えたら警告（誤接続 or 攻撃の予兆）— 未実装（閾値監視・警告連携なし）
- [x] 監査: 設定変更・コマンド発行・削除は全件 audit_log（[NFR04](../non-functional/NFR04-audit-log.md) のハッシュチェーン）— 部分実装（[#494](https://github.com/cometa-kaito/kimiterrace-v2/pull/494) 設定変更 + [#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499) コマンド発行を audit_log に記録）残: 削除（ソフトデリート）操作自体が UI 未実装のため未対象

### 6. テスト

- [x] `__tests__/api/tv/config/`（GET/POST ハンドラ）— 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)/[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)、`apps/web/__tests__/api/tv-config.api.test.ts`（401/200/unknown/429/commands 同梱/XFF）+ `tv-commands-ack.api.test.ts`（ack 冪等/401/429））
  - GET: 認証なし → 401 / 認証あり device_id 指定 → 200 / device_id 未登録 → 200 + unknown=true
  - POST: 設定 upsert → version +1 / 監査ログ 1 件追加（※ 設定保存は Server Action 経路。コマンド ack は `POST /api/tv/commands/ack`）
- [x] `__tests__/rls/tv-devices.test.ts` — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)/[#499](https://github.com/cometa-kaito/kimiterrace-v2/pull/499)、`packages/db/__tests__/rls/tv-devices.test.ts`（自校/他校/system_admin/deny-by-default/device_id 一意/pollTvConfig）+ `tv-device-commands.test.ts`（enqueue/poll/ack のテナント分離））
  - school_admin: 自校 row のみ操作可
  - system_admin: 全件操作可
  - 未認証セッション → 拒否
  - `tv_device_commands` / `tv_device_tokens` も school_id で同様に分離（他校 row 不可視）（※ `tv_device_tokens` は表未実装のため対象外）
- [~] `__tests__/ui/admin-tv-devices/` — 部分実装（[#496](https://github.com/cometa-kaito/kimiterrace-v2/pull/496)、`apps/web/__tests__/tv/tv-devices-page.test.tsx`：編集/履歴リンクの role 出し分けスナップショット）残: signage_url 自動抽出のスナップショット（機能未実装）、コマンド発行 UI の component テストは未追加（DB 層は RLS テストで担保）
  - signage_url 入力 → 教室コンテキスト自動抽出のスナップショット
  - school_admin は他校 TV を参照不可（403）
  - コマンド発行 → tv_device_commands に 1 件
- [ ] e2e（Playwright）— 未実装（TV ポーリング → 設定変更 → 反映の貫通 e2e なし。API/RLS の実 PG テストで配線を担保）
  - TV ポーリング模擬 → 設定変更 → 60秒以内に反映を観測

## 実装分割方針（[CLAUDE.md ルール 6](../../../CLAUDE.md): 1 PR ≤500 行）

本要件は 1 PR で実装できる分量を超えるため、最低でも以下の単位に分割して PR を立てる:

1. **スキーマ + migration + RLS**: `tv_devices` / `tv_device_commands` / `tv_device_tokens` の Drizzle スキーマ、`events` への `tv_device_id` 追加、RLS ポリシー手書き SQL（+ global-setup.ts ローダ登録）、`__tests__/rls/tv-devices.test.ts`
2. **ポーリング API**: `GET /api/tv/config`（認証・レート制限・`last_seen_at` 更新・unknown 応答）と `__tests__/api/tv/config/`
3. **管理 UI**: `/admin/tv-devices` 一覧 + 詳細・編集 + オンボーディング + 監査ビュー、signage URL 自動抽出、`__tests__/ui/admin-tv-devices/`
4. **コマンドキュー**: `tv_device_commands` 発行 UI とポーリング応答への commands 反映、e2e

§3（F13 Webhook payload 拡張）は影響範囲が小さければ 1 か 2 に同梱可。

## 関連

- 前段: [F13 (来場検知 Webhook)](F13-presence-sensor-webhook.md)（device_id / 教室コンテキストは Webhook 受信側で受け取り済）
- 後段: [F08 (効果ダッシュボード)](F08-effect-dashboard.md)（TV ヘルスステータスとの統合表示）
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR04 (監査)](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/tv/`, `__tests__/rls/tv-devices.test.ts`, `__tests__/ui/admin-tv-devices/`

## 旧 LP リファレンス実装（移行元）

PoC 期間中は本 v2 に先行して **LP リポジトリ `edix-lp/` に Turso（ホスト型 SQLite）で素朴版**を 2026-05-30 に投入済み。
v2 への移植時は以下を参照しつつ、本 F15 の規律（RLS、監査、Drizzle、PII マスキング、テスト緑）に従って再実装する:

- `app/api/tv/config/route.ts` — GET/POST 受信ハンドラの最小実装
- `app/sensors/page.tsx` — 簡易ダッシュボード（v2 では `/admin/tv-devices` に統合）
- `lib/sensor-db.ts` の `getTvDevice` / `upsertTvDevice` / `touchTvDevice` / `listTvDevices` — Turso ラッパー（v2 では Drizzle スキーマに置換）
- `migrations/003_multi_device.sql` — tv_devices + motion_events 教室列の素朴版
- TV 側 `ConfigPoller.kt` — 60秒ポーリング実装（v2 で API URL を切替えるだけで再利用可）

PoC 終了後（2026-10-01 以降）、本 F15 に従って v2 側を実装し、データ移行（PoC 期間 Turso → Cloud SQL、特に tv_devices と TV のリモコン発行履歴）を経て **LP 側のエンドポイントは廃止** する。

## 将来拡張（Phase 2 以降）

- TV 個別の `tv_device_tokens` 発行（現状は共通シークレット）
- WebPush で push 通知（コマンドを即配信、ポーリング間隔短縮の代替）
- TV ファームウェアアップデート配布（APK 配信パイプライン）
- 多教室の一括設定変更（テンプレート機構）
- スケジュールに「臨時休業日」「祝日カレンダー」連携
- TV のスクリーンキャプチャをリモートで取得（運用診断）
