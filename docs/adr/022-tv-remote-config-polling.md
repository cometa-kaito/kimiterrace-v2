# ADR-022: TV リモート設定はポーリング方式を採用（push 型 WebSocket/FCM 不採用）

- 状態: Proposed
- 日付: 2026-05-30
- 関連: [F15 (TVリモート管理)](../requirements/functional/F15-tv-device-management.md), [F13 (来場検知 Webhook)](../requirements/functional/F13-presence-sensor-webhook.md), [ADR-020 (SwitchBot Webhook)](020-presence-sensor-switchbot-webhook.md), [NFR01](../requirements/non-functional/NFR01-performance.md), [NFR03](../requirements/non-functional/NFR03-security.md)

## 文脈

学校設置済の Google TV（自作 Android アプリ稼働）に対し、リモートで設定変更（サイネージ URL、スケジュール、センサ MAC 等）とコマンド配信（リロード等）を行う仕組みを設計する必要がある。

選択肢:

- **ポーリング型**: TV が一定間隔でサーバを叩き、最新設定を取得
- **push 型 (WebSocket)**: サーバ ↔ TV の双方向長期接続、設定変更時に即配信
- **push 型 (FCM / Firebase Cloud Messaging)**: Google の push 配信を使う
- **ハイブリッド**: 通常はポーリング、緊急時のみ push

学校環境の制約:

- 学校 Wi-Fi は **MAC アドレス制限** や **アウトバウンドのみ許可** など、サーバ → TV 方向の通信が事実上不可能なケースが多い
- 学校 IT 担当者の協力に頼る運用は持続困難（PoC は岐南工業高校・電子工学科1〜3年で開始）
- 学校ごとに Wi-Fi 仕様が異なる
- TV の数は最大数百台（学校数 × クラス数）規模を想定

要件:

- 設定変更の反映までの許容遅延: **数分以内**（教員/管理者が「変更したのに反映されない」と感じない範囲）
- 24時間 365日 稼働
- TV から能動接続でしかインターネットに出られない環境下でも動作すること
- 学校 IT 担当への追加要請ゼロで完結

## 決定

**ポーリング方式（pull）を採用する。間隔は 60秒、TV 側で `ConfigPoller` が `GET /api/tv/config?device_id=...&key=...` を叩く。**

### 設計詳細

- TV は OkHttp で 60秒ごとに HTTPS GET
- レスポンスの `version` を local の `last_seen_version` と比較し、新しい時のみ SharedPreferences と AlarmManager を更新
- `commands.*` は version 増分時のみ実行（再実行抑制）
- 認証は `?key=<token>` でサーバ側比較（共通シークレット、Phase 2 で TV 個別トークン化）
- レート制限はサーバ側で device_id × 分単位（[NFR01](../requirements/non-functional/NFR01-performance.md)）

### 通信フロー

```
学校 Wi-Fi（アウトバウンドのみ）
  ↓
TV 上の ConfigPoller
  ↓ HTTPS GET 60秒ごと
Cloud Run (apps/web、asia-northeast1 / ADR-002)
  ↑
管理者 Web UI POST で設定変更
  ↓
Cloud SQL (tv_devices テーブル)
```

サーバから TV へは **一度も能動接続しない**。

## 検討した代替案

### 代替 A: push 型 WebSocket（双方向長期接続）

- 却下理由: 学校 Wi-Fi の NAT/ファイアウォール越えで接続維持が不安定。アイドルタイムアウトで切断され再接続のロジックが複雑化
- 副次理由: TV 側の常駐コスト（Foreground Service が WebSocket を維持する負荷）
- 副次理由: 数百台規模のスケーリング時、Cloud Run のインスタンス当たり同時接続数の制約
- 副次理由: 監査ログ・タイムスタンプ管理が pull より煩雑

### 代替 B: push 型 FCM（Firebase Cloud Messaging）

- 却下理由: Google アカウント・Play Services の常時稼働が必須。Google TV カスタム ROM や法人運用機種で Play Services が制限・無効化される可能性
- 副次理由: メッセージ到達保証なし（ベストエフォート）、再送リトライ機構の自前実装が結局必要
- 副次理由: GCP プロジェクトとは別の Firebase プロジェクトを混在させたくない（[ADR-002](002-cloud-run-vs-functions.md) と整合）

### 代替 C: ハイブリッド（通常 pull + 緊急 push）

- 却下理由: 2 系統運用の複雑度に対し、緊急性の優位は限定的（60秒以内反映で多くの運用要件をカバー）
- 副次理由: 緊急 push 経路を持つこと自体がセキュリティ攻撃面を増やす
- 副次理由: テスト・運用負荷の倍増

### 代替 D: ポーリング間隔を更に短く（10秒、5秒）

- 却下理由: サーバ負荷とコストが線形に増加。60秒で要件を満たすなら過剰
- 副次理由: TV のバッテリ・CPU 負荷増（Foreground Service が頻繁にネット I/O）

## 結果（Consequences）

### 良い影響

- 学校 Wi-Fi 仕様に依存しない（アウトバウンドのみで成立）
- TV 側実装が単純（OkHttp + setInterval 相当のループだけ）
- サーバ側スケーリングが容易（GET をキャッシュ可、CDN 化も可）
- 認証・監査・テストが pull で完結（リクエスト1個1個が独立）
- 学校 IT 担当への追加要請ゼロ
- 学校環境変化（Wi-Fi 切替、IP 変更）に強い

### 悪い影響 / リスク

- **設定変更の反映遅延（最大 60秒）**: 緊急のサイネージ取り下げ等で遅く感じる可能性
  - 緩和策: 管理 UI 上で「変更を反映中（最大 60秒）」を明示
  - 緩和策: 緊急時はインターバルを 10秒に下げるリモート設定（メタ設定）も可
- **TV 側の常時 HTTP リクエストによる通信費**: 月間 約 4.3 万リクエスト/台 × N 台
  - 緩和策: レスポンスを 304 Not Modified 化（version unchanged 時）
  - 緩和策: 学校 Wi-Fi で接続費追加なし、サーバ側は CDN キャッシュで吸収
- **共通シークレット運用の脆弱性**: 1 つ漏洩すれば全 TV 設定にアクセス可能
  - 緩和策: Phase 2 で TV 個別の `tv_device_tokens` 発行（F15 §5）
  - 緩和策: Secret Manager 半年ローテーション

### トレードオフ

- 「即時性 vs 学校環境耐性」のうち **学校環境耐性** に振った設計
- 「push の効率 vs pull の単純さ」のうち **pull の単純さ** に振った設計
- 「リアルタイム性 vs スケーラビリティ」のうち **スケーラビリティ** に振った設計
- 将来 ISMAP 要件等で「リアルタイム監査」が必要になれば、本 ADR を Superseded として再評価可能（WebSocket 追加 or SSE 経由の差分通知）
