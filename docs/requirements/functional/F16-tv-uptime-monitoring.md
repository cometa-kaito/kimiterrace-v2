# F16: TV 死活・起動監視とアラート

- 状態: スキーマ＋ギャップチェッカ＋ダウンタイム記録＋稼働サマリ UI 実装済 / アラート通知・起動報告は未着手 — `tv_devices` 監視カラム + `tv_device_downtime`/RLS・down/recover 判定チェッカ（OFF 時間帯閾値緩和 + send-once + cause_hint=reboot 推定）・ダウンタイム履歴/稼働率% UI・monitoring トグルは DONE（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)/[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)/[#500](https://github.com/cometa-kaito/kimiterrace-v2/pull/500)）。残: アラート通知の実配信（Sentry/メール、現状は alert_state 反転 + ログのみ）・起動報告 `POST /api/tv/heartbeat`・dead man's switch・e2e。※ チェッカは仕様の `POST /api/tv/health-check` Route Handler でなく Cloud Run Job として実装（ADR-023 整合、後述 §2）
- 関連 ADR: [ADR-023（TV 死活監視は last_seen ギャップ + 定期チェッカ + 多段アラート）](../../adr/023-tv-liveness-monitoring-alerting.md), [ADR-022 (TV ポーリング)](../../adr/022-tv-remote-config-polling.md), [ADR-013 (Sentry)](../../adr/013-sentry.md), [ADR-014 (観測)](../../adr/014-observability.md), [ADR-020 (SwitchBot Webhook)](../../adr/020-presence-sensor-switchbot-webhook.md)
- 関連要件: [F15 (TVデバイスリモート管理)](F15-tv-device-management.md), [F13 (来場検知 Webhook)](F13-presence-sensor-webhook.md), [F08 (効果ダッシュボード)](F08-effect-dashboard.md), [NFR01 (性能)](../non-functional/NFR01-performance.md), [NFR03 (セキュリティ)](../non-functional/NFR03-security.md), [NFR04 (監査ログ)](../non-functional/NFR04-audit-log.md)
- 関連 issue: [#140](https://github.com/cometa-kaito/kimiterrace-v2/pull/140)（要件 + ADR-023）

## 概要

学校設置の Google TV（自作 Android アプリ `com.kimiterrace.tvbridge` 稼働）が **「いつの間にか電源OFF・ネット断・アプリ停止」で検知データを欠測** しても、運用者が気づかず放置される事故を防ぐための **能動的な死活・起動監視とアラート基盤**。

[F15](F15-tv-device-management.md) は TV 設定のリモート管理＋管理画面での稼働ステータス表示（受動）までを規定する。本 F16 はその上に以下を追加する:

- **ダウン検知**: 一定時間ポーリングが途絶した TV をサーバが自動判定
- **アラート通知**: ダウン／復帰／予期せぬ再起動を運用者へプッシュ
- **起動・再起動の検知とダウンタイム記録**: 「いつ・何分落ちていたか」を残す

### 動機（PoC 実機で発生）

- 1年機（ORION AI PONT）が **TV 本体の電源オフタイマー（16:30）** で勝手に電源OFF → 誰も気づかず検知ゼロの時間が発生（電源対策後も「次に切れたら即気づきたい」）
- TV を学校で電源断・LAN 切替された際、復帰したか外から分からなかった

### 土台

監視の心拍は **既存のポーリング**（[ADR-022](../../adr/022-tv-remote-config-polling.md)）を再利用する。TV は 60秒ごとに `GET /api/tv/config` を叩き、サーバは `tv_devices.last_seen_at` を更新する。**この `last_seen_at` の鮮度がそのまま死活信号**になる。新たな常時接続（WebSocket 等）は張らない（[ADR-023](../../adr/023-tv-liveness-monitoring-alerting.md)）。

## ユーザーストーリー

- **システム管理者として**、TV が一定時間応答しなくなったら（電源OFF/ネット断/アプリ停止）、自分が気づく前に通知してほしい（検知欠測の早期復旧）。
- **システム管理者として**、各 TV の稼働率（uptime %）と直近のダウンタイム履歴を見たい（PoC 報告・保守判断）。
- **システム管理者として**、TV が再起動したこと・いつ起動したかを知りたい（勝手な電源断や停電の発見）。
- **校務管理者（school_admin）として**、自校の TV のダウン通知だけ受け取りたい（テナント分離）。
- **システム管理者として**、スケジュール OFF 時間帯（夜間・休日の黒画面中）の誤報は抑えてほしい。

## 受け入れ条件

### 1. データモデル

- [x] `tv_devices`（F15）にカラム追加（drizzle-kit 生成）: — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`packages/db/src/schema/tv-devices.ts`：last_boot_at / app_version / monitoring_enabled(default true) / alert_state(enum tv_alert_state: ok|down, default ok) を保持）
  - `last_boot_at` (timestamptz, nullable) — TV からの起動報告（§3）
  - `app_version` (text, nullable) — 起動報告で受領
  - `monitoring_enabled` (boolean, default true) — TV 個別に監視 ON/OFF（メンテ除外用）
  - `alert_state` (enum: `ok` | `down`, default `ok`) — 現在のアラート状態（重複通知抑止に使用）
- [x] 新規テーブル `tv_device_downtime`（ダウンタイム/インシデント記録、school_id で RLS、監査カラム）— 実装済（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`packages/db/src/schema/tv-device-downtime.ts`：device_id/school_id/went_down_at/recovered_at/duration_sec/cause_hint(enum unknown|reboot|network)/notes + auditColumns。RLS は `migrations/0018_tv_device_downtime_rls.sql`）
  - `id` (uuid, PK), `device_id` (FK → tv_devices.device_id), `school_id` (FK, RLS テナント分離)
  - `went_down_at` (timestamptz) — ダウン判定の基準（最後の `last_seen_at`）
  - `recovered_at` (timestamptz, nullable) — ポーリング再開時刻
  - `duration_sec` (int, nullable) — 復帰時に算出
  - `cause_hint` (enum: `unknown` | `reboot` | `network`, nullable) — 復帰時に起動報告と突合して推定
  - 監査カラム（RLS 有効）
- [x] テーブル/カラムは drizzle-kit 生成、RLS は手書き SQL（[CLAUDE.md ルール 3](../../../CLAUDE.md)、F15 と同方式で `global-setup.ts` ローダ登録）— 実装済（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、DDL は `drizzle/20260602041304_f16_tv_device_downtime.sql`、RLS は `migrations/0018`、auto-discovery loader に乗る）

### 2. ダウン/復帰判定（サーバ側・定期チェッカ）

- [x] **判定ロジックはサーバ集約**（[ADR-023](../../adr/023-tv-liveness-monitoring-alerting.md)）。`last_seen_at` ギャップで判定: — 実装済（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`packages/db/src/queries/tv-liveness.ts` `classifyTvLiveness`（純関数）：`now - last_seen_at > DOWN_THRESHOLD`（既定 3 分）かつ monitoring_enabled で down、鮮度復帰で ok。境界は `>` のみ down・last_seen NULL は down にしない）
  - `down`: `now - last_seen_at > DOWN_THRESHOLD`（既定 3分 = 60秒ポーリング × 3回欠落）かつ `monitoring_enabled`
  - `ok`（復帰）: その後 `last_seen_at` が更新された
- [~] **定期チェッカ** `POST /api/tv/health-check`（Cloud Scheduler → Cloud Run Route Handler、内部認証）を **1分間隔**で実行: — 部分実装（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`packages/db/src/queries/tv-liveness-checker.ts` `runTvLivenessCheck` + `apps/jobs/src/tv-liveness/`：全 TV 走査で down→downtime 行 INSERT + alert_state='down'、recover→recovered_at/duration_sec 記録 + alert_state='ok'、遷移なしは no-op（send-once、FOR UPDATE で二重 INSERT 防止））⚠ 仕様の `POST /api/tv/health-check` Route Handler ではなく **Cloud Run Job**（Cloud Scheduler 1 分起動）として実装（ADR-023 整合、Route Handler 形は未採用）。ダウンアラートの実発火（§4）は alert_state 反転のみで配信は未実装
  - 全 `tv_devices` を走査し、down 遷移 / recover 遷移を検出
  - down 遷移: `tv_device_downtime` に行作成（`went_down_at`）、`alert_state='down'`、ダウンアラート発火（§4）
  - recover 遷移: 該当 downtime 行に `recovered_at` / `duration_sec` 記録、`alert_state='ok'`、復帰アラート
  - 遷移が無ければ no-op（**send-once**: down→down で連投しない）
- [x] 誤報抑制: `schedule_json` の OFF 時間帯は **死活評価をスキップ**（端末は生存・黒画面のみ＝応答なしに数えない）— 実装済（当初 [#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492) は OFF 閾値を緩めるのみだったが、運営整理 BUG-2 / PR #851 で「OFF は評価スキップ（状態凍結）」へ改訂。`tv-liveness.ts` `classifyTvLiveness` がループ先頭で `isSignageOffHours` をスキップ。`offHoursThresholdSec` は `@deprecated`（未使用・互換残置）。復帰不能の応答なしは ON 入り後に通常閾値で検出）
- [ ] **チェッカ自体の死活**（cron が止まったら気づけない問題）: 最終実行時刻を観測し、[ADR-014](../../adr/014-observability.md) の dead man's switch / Cloud Monitoring uptime に乗せる — 未実装（`tv-liveness-job.ts` コメントで Terraform follow-up に明記。dead man's switch 配線なし）

### 3. TV → サーバ 起動報告（任意・精度向上）

- [ ] TV アプリ `BootReceiver` が `BOOT_COMPLETED` 時に起動を報告（ポーリング query 拡張 or 専用 `POST /api/tv/heartbeat`）: — 未実装（`POST /api/tv/heartbeat` エンドポイント不在、ポーリング query の boot_at/app_version 受け入れもなし）
  - `device_id`, `boot_at`（端末起動起点）, `app_version`
- [~] サーバは `tv_devices.last_boot_at` / `app_version` を更新。`last_boot_at` が前回より新しければ「再起動」と判定し downtime の `cause_hint='reboot'` を補強（任意で再起動アラート）— 部分実装（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`tv-liveness.ts` `inferCauseHint`：last_boot_at が went_down_at 以降に進んでいれば復帰時 cause_hint='reboot' を補強する判定は実装済）残: last_boot_at を更新する起動報告の受信経路（§3 上記）が無いため、現状 last_boot_at は埋まらず実効しない
- [x] 起動報告が無くても §2 のギャップ判定だけで死活は成立する（報告は付加・後方互換）— 実装済（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`classifyTvLiveness` は last_seen_at ギャップのみで down/recover を判定し last_boot_at に依存しない。実 PG テストで固定）

### 4. アラート通知

- [ ] 種別: `device_down` / `device_recovered` / `unexpected_reboot` — 未実装（アラート種別の配信実装なし。down/recover 遷移は alert_state 列の反転 + 構造化ログのみ）
- [ ] チャネルは [ADR-023](../../adr/023-tv-liveness-monitoring-alerting.md) で決定。第一段は [Sentry (ADR-013)](../../adr/013-sentry.md) ＋ メール、将来 Slack/LINE — 未実装（`apps/jobs/src/tv-liveness/run.ts` コメントで「アラート配信は follow-up スライス」と明記。Sentry/メール配線なし）
- [~] **重複抑止**: `alert_state` 遷移時のみ通知。復帰時に解決通知 — 部分実装（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`runTvLivenessCheck` が down→down を no-op にし alert_state 遷移時のみ状態を反転する send-once 基盤は実装済）残: その遷移を契機に「通知」する配信層が未実装（抑止対象の通知自体が無い）
- [ ] 宛先: school_admin は自校 TV のみ、system_admin は全件（[ADR-019 (RLS)](../../adr/019-rls-two-layer-tenant-isolation.md) + 通知購読設定）— 未実装（通知購読設定・宛先解決ロジック不在。配信層が無いため）
- [ ] 通知に学校名・教室名の生値を載せない（device_id 先頭 8 桁等にマスク、[NFR03](../non-functional/NFR03-security.md)）。発火・配信成否は監査・観測（[NFR04](../non-functional/NFR04-audit-log.md), [ADR-014](../../adr/014-observability.md)）— 未実装（通知配信が無いためマスク/配信監査も不在。なお downtime 行・サマリ自体は device_id 先頭短縮で UI 表示）

### 5. Web 管理 UI（F15 の `/admin/tv-devices` 拡張）

- [x] 一覧の稼働ステータスを `last_seen_at` ベースに統一（F15 §4.1 の判定を本 F16 の閾値へ寄せる）: 🟢 online / 🟡 quiet（OFF 時間帯）/ 🔴 down — 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)、`apps/web/lib/tv/status.ts` `classifyTvLiveness`（online/quiet/down）+ `TV_STATUS_ICON`/`TV_STATUS_LABEL` を一覧で使用）
- [~] 詳細画面: 稼働率（直近 24h / 7d の uptime %）、最終起動時刻、ダウンタイム履歴（`tv_device_downtime`：いつ・何分・cause_hint）— 部分実装（[#500](https://github.com/cometa-kaito/kimiterrace-v2/pull/500)、`apps/web/app/admin/tv-devices/[deviceId]/history/page.tsx` + `getTvUptimeSummary`/`listTvDeviceDowntime`：稼働サマリ（窓内 uptime）+ ダウンタイム履歴（went_down/duration/cause_hint、継続中明示）を JST 表示）残: 「最終起動時刻」表示は last_boot_at（§3 起動報告）未受信のため実効しない
- [x] `monitoring_enabled` トグル（メンテ中 TV を一時除外）— 実装済（[#494](https://github.com/cometa-kaito/kimiterrace-v2/pull/494)、`_components/TvConfigEditForm.tsx`：monitoringEnabled チェックボックスを編集フォームで保存）
- [x] 色 + テキスト両方で示す（[NFR05](../non-functional/NFR05-accessibility.md)）— 実装済（[#487](https://github.com/cometa-kaito/kimiterrace-v2/pull/487)/[#500](https://github.com/cometa-kaito/kimiterrace-v2/pull/500)、ステータス・継続時間・原因を色のみに依存せずアイコン + テキスト併記、継続中は「継続中」明示）

### 6. セキュリティ・運用

- [~] `POST /api/tv/health-check` は内部呼び出し専用（Cloud Scheduler の OIDC or 共有シークレット、外部叩き禁止、`runtime='nodejs'`）— 部分実装（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、チェッカは Cloud Run Job（`apps/jobs/src/tv-liveness/`）として実装し外部 HTTP に晒さない＝内部専用は満たす）⚠ ただし仕様の `POST /api/tv/health-check` Route Handler 形ではなく Job のため、OIDC/共有シークレット/runtime 設定の AC は Job 起動権限（Scheduler SA）に置換
- [ ] `POST /api/tv/heartbeat`（起動報告）は TV からの外部 origin として F15 §2 と同じトークン体系で認証 — 未実装（heartbeat エンドポイント自体が未実装（§3））
- [x] しきい値（`DOWN_THRESHOLD` 等）は環境変数 / 設定で調整可能（PoC で調整余地）— 実装済（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`apps/jobs/src/tv-liveness/run.ts` `resolveThresholds`：down 閾値 / OFF 時閾値を env で上書き可、未指定は既定にフォールバック。unit テスト `run.test.ts` で固定）

### 7. テスト

- [~] `__tests__/api/tv/health-check/`: down 遷移で downtime 1件 + alert 1件 / recover で duration 記録 + 解決通知 / 遷移なしで no-op（重複なし）/ OFF 時間帯の閾値緩和 — 部分実装（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)、`packages/db/__tests__/rls/tv-device-downtime.test.ts`（実 PG で down 行作成 / 冪等 / recover で duration / monitoring OFF / phantom INSERT 根治）+ `__tests__/unit/tv-liveness.test.ts`（純関数 down/recover/no-op/OFF 緩和）+ `apps/jobs/src/tv-liveness/__tests__/run.test.ts`（閾値解決））残: alert 1 件の検証は通知配信が未実装のため対象外、Route Handler でなく checker/Job 経路で検証
- [ ] `__tests__/api/tv/heartbeat/`: 起動報告で `last_boot_at` 更新 / `boot_at` 進行で reboot 判定 — 未実装（heartbeat エンドポイント未実装。cause_hint=reboot 推定の純関数テストは `tv-liveness.test.ts` にあるが起動報告受信のテストは不在）
- [x] `__tests__/rls/tv-device-downtime.test.ts`: school_admin 自校のみ / system_admin 全件 / 未認証拒否 — 実装済（[#492](https://github.com/cometa-kaito/kimiterrace-v2/pull/492)/[#500](https://github.com/cometa-kaito/kimiterrace-v2/pull/500)、`packages/db/__tests__/rls/tv-device-downtime.test.ts`（書込/分離）+ `tv-downtime-read.test.ts`（履歴/サマリの自校のみ・system_admin 全件・非 vacuous））
- [~] `__tests__/ui/admin-tv-devices/`: uptime% とダウンタイム履歴のスナップショット、monitoring トグル — 部分実装（[#496](https://github.com/cometa-kaito/kimiterrace-v2/pull/496)、`apps/web/__tests__/tv/tv-devices-page.test.tsx`（リンク role 出し分け）+ `apps/web/__tests__/lib/tv-downtime-format.test.ts`（duration/cause/JST 整形））残: history ページ全体・monitoring トグルの component スナップショットは未追加（読取クエリは実 PG テストで担保）
- [ ] e2e（Playwright）: ポーリング途絶を模擬 → チェッカ実行 → down 判定 → 通知 → ポーリング再開 → recover の一連 — 未実装（貫通 e2e なし。checker の down/recover は実 PG テストで担保）

## 実装分割方針（[CLAUDE.md ルール 6](../../../CLAUDE.md): 1 PR ≤500 行）

1. **スキーマ**: `tv_devices` カラム追加 + `tv_device_downtime` + RLS 手書き SQL + RLS テスト
2. **定期チェッカ**: `POST /api/tv/health-check`（down/recover 判定・downtime 記録）+ テスト
3. **アラート通知**: チャネル実装・重複抑止・購読 + テスト
4. **起動報告**: `POST /api/tv/heartbeat` + TV 側 `BootReceiver` 拡張（任意・後追い可）
5. **管理 UI 拡張**: uptime% / ダウンタイム履歴 / monitoring トグル

## 関連

- 前段: [F15 (TVデバイスリモート管理)](F15-tv-device-management.md)（`last_seen_at` 心拍・稼働ステータス表示の土台）
- 土台/方式 ADR: [ADR-022 (ポーリング)](../../adr/022-tv-remote-config-polling.md) / [ADR-023 (死活監視方式)](../../adr/023-tv-liveness-monitoring-alerting.md)
- 観測・通知: [ADR-013 (Sentry)](../../adr/013-sentry.md), [ADR-014 (観測)](../../adr/014-observability.md), [NFR04 (監査)](../non-functional/NFR04-audit-log.md)
- 表示統合: [F08 (効果ダッシュボード)](F08-effect-dashboard.md)

## 旧 LP リファレンス実装（PoC 先行）

PoC 期間は LP リポジトリ `edix-lp/` の Turso 素朴版で死活の素地が動いている:

- `app/api/tv/config/route.ts` の `touchTvDevice`（GET ごとに `last_seen` 更新）＝心拍の源
- `app/sensors/page.tsx` のデバイスカード（最終ポーリング時刻・🟢/🟡/🔴 表示）＝受動監視の素朴版
- PoC では「定期チェッカ + 通知」は未実装。必要なら edix-lp に Vercel Cron（`/api/tv/health-check` 相当）で軽量先行も可。v2 では本 F16 の規律（RLS・監査・テスト緑）で正式実装する。

## 将来拡張（Phase 2 以降）

- **電池残量監視**: SwitchBot センサの `battery` を webhook payload から拾い、低下時アラート（F13 連携）
- **異常検知**: 検知数が普段の同時間帯比で急減 → センサ/設置異常の予兆通知
- **スクリーンキャプチャ**: 「実際に何が映っているか」を遠隔確認（運用診断）
- **アラートのエスカレーション**: 一定時間未復旧で上位へ通知
