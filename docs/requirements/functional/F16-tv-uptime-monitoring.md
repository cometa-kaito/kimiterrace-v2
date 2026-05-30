# F16: TV 死活・起動監視とアラート

- 状態: Draft（新規）
- 関連 ADR: 新規 [ADR-023（TV 死活監視は last_seen ギャップ + 定期チェッカ + 多段アラート）](../../adr/023-tv-liveness-monitoring-alerting.md), [ADR-022 (TV ポーリング)](../../adr/022-tv-remote-config-polling.md), [ADR-013 (Sentry)](../../adr/013-sentry.md), [ADR-014 (観測)](../../adr/014-observability.md), [ADR-020 (SwitchBot Webhook)](../../adr/020-presence-sensor-switchbot-webhook.md)
- 関連要件: [F15 (TVデバイスリモート管理)](F15-tv-device-management.md), [F13 (来場検知 Webhook)](F13-presence-sensor-webhook.md), [F08 (効果ダッシュボード)](F08-effect-dashboard.md), [NFR01 (性能)](../non-functional/NFR01-performance.md), [NFR03 (セキュリティ)](../non-functional/NFR03-security.md), [NFR04 (監査ログ)](../non-functional/NFR04-audit-log.md)
- 関連 issue: TBD（本 PR で起票予定）

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

- [ ] `tv_devices`（F15）にカラム追加（drizzle-kit 生成）:
  - `last_boot_at` (timestamptz, nullable) — TV からの起動報告（§3）
  - `app_version` (text, nullable) — 起動報告で受領
  - `monitoring_enabled` (boolean, default true) — TV 個別に監視 ON/OFF（メンテ除外用）
  - `alert_state` (enum: `ok` | `down`, default `ok`) — 現在のアラート状態（重複通知抑止に使用）
- [ ] 新規テーブル `tv_device_downtime`（ダウンタイム/インシデント記録、school_id で RLS、監査カラム）
  - `id` (uuid, PK), `device_id` (FK → tv_devices.device_id), `school_id` (FK, RLS テナント分離)
  - `went_down_at` (timestamptz) — ダウン判定の基準（最後の `last_seen_at`）
  - `recovered_at` (timestamptz, nullable) — ポーリング再開時刻
  - `duration_sec` (int, nullable) — 復帰時に算出
  - `cause_hint` (enum: `unknown` | `reboot` | `network`, nullable) — 復帰時に起動報告と突合して推定
  - 監査カラム（RLS 有効）
- [ ] テーブル/カラムは drizzle-kit 生成、RLS は手書き SQL（[CLAUDE.md ルール 3](../../../CLAUDE.md)、F15 と同方式で `global-setup.ts` ローダ登録）

### 2. ダウン/復帰判定（サーバ側・定期チェッカ）

- [ ] **判定ロジックはサーバ集約**（[ADR-023](../../adr/023-tv-liveness-monitoring-alerting.md)）。`last_seen_at` ギャップで判定:
  - `down`: `now - last_seen_at > DOWN_THRESHOLD`（既定 3分 = 60秒ポーリング × 3回欠落）かつ `monitoring_enabled`
  - `ok`（復帰）: その後 `last_seen_at` が更新された
- [ ] **定期チェッカ** `POST /api/tv/health-check`（Cloud Scheduler → Cloud Run Route Handler、内部認証）を **1分間隔**で実行:
  - 全 `tv_devices` を走査し、down 遷移 / recover 遷移を検出
  - down 遷移: `tv_device_downtime` に行作成（`went_down_at`）、`alert_state='down'`、ダウンアラート発火（§4）
  - recover 遷移: 該当 downtime 行に `recovered_at` / `duration_sec` 記録、`alert_state='ok'`、復帰アラート
  - 遷移が無ければ no-op（**send-once**: down→down で連投しない）
- [ ] 誤報抑制: `schedule_json` の OFF 時間帯は `DOWN_THRESHOLD` を緩める（既定 30分）。閾値は環境変数で調整可
- [ ] **チェッカ自体の死活**（cron が止まったら気づけない問題）: 最終実行時刻を観測し、[ADR-014](../../adr/014-observability.md) の dead man's switch / Cloud Monitoring uptime に乗せる

### 3. TV → サーバ 起動報告（任意・精度向上）

- [ ] TV アプリ `BootReceiver` が `BOOT_COMPLETED` 時に起動を報告（ポーリング query 拡張 or 専用 `POST /api/tv/heartbeat`）:
  - `device_id`, `boot_at`（端末起動起点）, `app_version`
- [ ] サーバは `tv_devices.last_boot_at` / `app_version` を更新。`last_boot_at` が前回より新しければ「再起動」と判定し downtime の `cause_hint='reboot'` を補強（任意で再起動アラート）
- [ ] 起動報告が無くても §2 のギャップ判定だけで死活は成立する（報告は付加・後方互換）

### 4. アラート通知

- [ ] 種別: `device_down` / `device_recovered` / `unexpected_reboot`
- [ ] チャネルは [ADR-023](../../adr/023-tv-liveness-monitoring-alerting.md) で決定。第一段は [Sentry (ADR-013)](../../adr/013-sentry.md) ＋ メール、将来 Slack/LINE
- [ ] **重複抑止**: `alert_state` 遷移時のみ通知。復帰時に解決通知
- [ ] 宛先: school_admin は自校 TV のみ、system_admin は全件（[ADR-019 (RLS)](../../adr/019-rls-two-layer-tenant-isolation.md) + 通知購読設定）
- [ ] 通知に学校名・教室名の生値を載せない（device_id 先頭 8 桁等にマスク、[NFR03](../non-functional/NFR03-security.md)）。発火・配信成否は監査・観測（[NFR04](../non-functional/NFR04-audit-log.md), [ADR-014](../../adr/014-observability.md)）

### 5. Web 管理 UI（F15 の `/admin/tv-devices` 拡張）

- [ ] 一覧の稼働ステータスを `last_seen_at` ベースに統一（F15 §4.1 の判定を本 F16 の閾値へ寄せる）: 🟢 online / 🟡 quiet（OFF 時間帯）/ 🔴 down
- [ ] 詳細画面: 稼働率（直近 24h / 7d の uptime %）、最終起動時刻、ダウンタイム履歴（`tv_device_downtime`：いつ・何分・cause_hint）
- [ ] `monitoring_enabled` トグル（メンテ中 TV を一時除外）
- [ ] 色 + テキスト両方で示す（[NFR05](../non-functional/NFR05-accessibility.md)）

### 6. セキュリティ・運用

- [ ] `POST /api/tv/health-check` は内部呼び出し専用（Cloud Scheduler の OIDC or 共有シークレット、外部叩き禁止、`runtime='nodejs'`）
- [ ] `POST /api/tv/heartbeat`（起動報告）は TV からの外部 origin として F15 §2 と同じトークン体系で認証
- [ ] しきい値（`DOWN_THRESHOLD` 等）は環境変数 / 設定で調整可能（PoC で調整余地）

### 7. テスト

- [ ] `__tests__/api/tv/health-check/`: down 遷移で downtime 1件 + alert 1件 / recover で duration 記録 + 解決通知 / 遷移なしで no-op（重複なし）/ OFF 時間帯の閾値緩和
- [ ] `__tests__/api/tv/heartbeat/`: 起動報告で `last_boot_at` 更新 / `boot_at` 進行で reboot 判定
- [ ] `__tests__/rls/tv-device-downtime.test.ts`: school_admin 自校のみ / system_admin 全件 / 未認証拒否
- [ ] `__tests__/ui/admin-tv-devices/`: uptime% とダウンタイム履歴のスナップショット、monitoring トグル
- [ ] e2e（Playwright）: ポーリング途絶を模擬 → チェッカ実行 → down 判定 → 通知 → ポーリング再開 → recover の一連

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
