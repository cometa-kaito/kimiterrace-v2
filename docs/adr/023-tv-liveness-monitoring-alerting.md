# ADR-023: TV 死活・起動監視は last_seen ギャップ + 定期チェッカ + 多段アラート（常時接続・外形監視 SaaS 不採用）

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [F16 (TV死活・起動監視)](../requirements/functional/F16-tv-uptime-monitoring.md), [F15 (TVリモート管理)](../requirements/functional/F15-tv-device-management.md), [ADR-022 (TVポーリング)](022-tv-remote-config-polling.md), [ADR-013 (Sentry)](013-sentry.md), [ADR-014 (観測)](014-observability.md), [NFR01](../requirements/non-functional/NFR01-performance.md)

## 文脈

学校設置の Google TV が「電源OFF・ネット断・アプリ停止」で検知データを欠測しても、運用者が気づかず放置される事故が PoC 実機で発生した（1年機が TV 本体の電源オフタイマーで 16:30 に勝手に電源OFF）。TV の死活・起動を能動的に監視し、ダウン時に通知する仕組みが要る。

制約（[ADR-022](022-tv-remote-config-polling.md) と共通）:

- 学校 Wi-Fi はアウトバウンドのみ許可が多く、**サーバ → TV の能動接続は事実上不可**
- TV は最大数百台規模
- TV は既に 60秒ごとに `GET /api/tv/config` をポーリングし、サーバが `tv_devices.last_seen_at` を更新している（**心拍が既に存在する**）

選択肢:

- **A**: 既存ポーリング心拍の `last_seen` ギャップを、サーバ側定期チェッカで判定
- **B**: サーバ → TV を常時接続（WebSocket/SSE）で keepalive 監視
- **C**: TV 側のみのウォッチドッグ（自己監視）
- **D**: 外形監視 SaaS（UptimeRobot 等）から TV を ping
- **E**: 死活専用の別 SaaS へ TV からハートビート送信

## 決定

**A を採用する。** 既存の `tv_devices.last_seen_at`（[ADR-022](022-tv-remote-config-polling.md) の 60秒ポーリングが更新）を死活信号とし、**サーバ側の定期チェッカ（Cloud Scheduler → `POST /api/tv/health-check`、1分間隔）** が `now - last_seen_at > 閾値（既定 3分）` で down 判定、`last_seen_at` 更新再開で recover 判定する。サーバ起点の新規常時接続は張らない。

起動・再起動の精度は **TV からの任意の起動報告（`BootReceiver` → heartbeat）** で補強するが、無くてもギャップ判定だけで死活は成立する（後方互換）。アラートは **多段**（第一段 Sentry [ADR-013](013-sentry.md) ＋ メール、将来 Slack/LINE）で、`alert_state` 遷移時のみ通知（重複抑止）。

## 検討した代替案

### B: サーバ → TV 常時接続（WebSocket/SSE）
- 却下: [ADR-022](022-tv-remote-config-polling.md) と同理由。学校 Wi-Fi の NAT/アウトバウンド制約でサーバ起点接続が不可。数百台の接続維持コスト。心拍が既にあるのに常駐経路を二重化するだけ。

### C: TV 側ウォッチドッグのみ
- 却下: **電源OFF・OS クラッシュ・ネット断そのものを TV 自身は報告できない**（落ちたら報告も送れない）。死活監視は外側（サーバ）から「欠落」を見るのが本質。自己監視はアプリ内クラッシュ復帰の補助にしかならない。

### D: 外形監視 SaaS から TV を ping
- 却下: TV はグローバルに到達可能でない（NAT 内・アウトバウンドのみ）。そもそも外部から ping/HTTP できない。

### E: 死活専用の別 SaaS へハートビート送信
- 却下: 既に自前の心拍（`last_seen`）があるのに外部ベンダ・別コスト・PII 越境リスクを増やす。[ADR-002](002-cloud-run-vs-functions.md)（GCP 集約）と不整合。ただし「チェッカ自体の死活（dead man's switch）」だけは Cloud Monitoring に寄せる（[ADR-014](014-observability.md)）。

## 結果（Consequences）

### 良い影響
- 既存ポーリング心拍を再利用。起動報告を足さなければ **TV 側コードはゼロ変更** で死活監視が成立
- 学校 Wi-Fi 仕様に非依存（[ADR-022](022-tv-remote-config-polling.md) の利点を継承）
- ダウン検知遅延は「ポーリング間隔 + チェッカ間隔 + 閾値」で決まり、実用上 1〜3分
- 判定・通知・監査がサーバ集約でテスト容易

### 悪い影響 / リスク
- **電源OFF / ネット断 / アプリ停止を区別できない**（すべて「ポーリング途絶」に見える）
  - 緩和: 復帰時の起動報告（`last_boot_at` 進行）で「再起動」だけは区別。それ以外は `cause_hint=unknown`
- **検知遅延（最大数分）**: 即時ではない。緊急取り下げ用途には不足だが死活監視としては許容
- **誤報**（瞬断・ポーリング 1 回欠落）: 閾値（3分 = 3回欠落）で抑制。OFF 時間帯は **死活評価をスキップ**（端末は生存し黒画面表示なだけ＝応答なしに数えない）。
  - 改訂（運営整理 BUG-2 / PR #851）: 旧仕様「OFF は `offHoursThresholdSec`(既定30分) で閾値を緩めるだけ」は、本番ジョブで緩和撤廃（OFF=ON 同値）後も OFF 中の正常な黒画面を down 計上していたため、「OFF は評価スキップ（状態凍結）」へ変更。復帰不能の本当の応答なしは ON 入り後に通常閾値で検出される。
- **チェッカ自体が止まると気づけない**: Cloud Monitoring uptime check / dead man's switch で二重化（[ADR-014](014-observability.md)）
- **共通シークレット運用**（[ADR-022](022-tv-remote-config-polling.md) と同じ脆弱性）: health-check は内部認証、heartbeat は TV トークン体系に従う

### トレードオフ
- 「即時性 vs 学校環境耐性・単純さ」のうち **環境耐性・単純さ** に振った（[ADR-022](022-tv-remote-config-polling.md) と一貫）
- 「原因特定の精度 vs 実装コスト」のうち、まず **低コストなギャップ判定** を採り、原因特定は起動報告で段階的に補強
- 将来リアルタイム性が必要になれば本 ADR を Superseded として SSE 差分通知等を再評価可能
