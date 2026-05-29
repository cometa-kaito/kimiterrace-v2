# ADR-020: 来場検知センサーは SwitchBot Webhook 方式・自前 DB 完結

- 状態: Proposed
- 日付: 2026-05-29
- 関連: [F13 (来場検知 Webhook)](../requirements/functional/F13-presence-sensor-webhook.md), [F07 (イベントログ)](../requirements/functional/F07-event-logging.md), [F12 (V1 機能移植)](../requirements/functional/F12-v1-port.md), [F08 (ダッシュボード)](../requirements/functional/F08-effect-dashboard.md), [NFR03](../requirements/non-functional/NFR03-security.md), [NFR04](../requirements/non-functional/NFR04-audit-log.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-002 (Cloud Run)](002-cloud-run-vs-functions.md), [ADR-019 (RLS)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md ルール 5](../../CLAUDE.md)

## 文脈

v2 設計初期の F12 / c4-context / c4-container では、サイネージ筐体側に **VL53L8CX × 4 + ESP32 × 4 の自作 LiDAR** を搭載し、滞留秒数を `apps/firmware/` 経由で取得して events テーブルに `event_type='dwell'` で書き込む構想だった。

PoC（2026-06-01〜09-30、岐南工業高校）開始 3 日前の段階で以下の状況が顕在化:

1. **自作筐体の信頼性懸念**: メザニン基板 × 3D プリント筐体の量産方針はあったものの、PoC 期間中に学校現場で 24/7 安定稼働させるには初物リスクが高い。
2. **学校への物理設置リードタイム**: 校内 LAN 接続申請・電源確保・先生方との設置調整に最低 1 週間。3 日では不可能。
3. **トラブル時の物理アクセスコスト**: 不具合が起きるたびに学校まで現地対応する運用は持続性に乏しい。
4. **クラウド経由でデータが届けば物理位置は自由**: SwitchBot 等の市販 IoT は Hub → クラウドの構成なので、受信側は Cloud Run のままで良い。
5. **MVP では「滞留秒数の正確な計測」より「時間帯別の動き検知回数」が広告主月次レポート（F09）の主要指標として十分**: 厳密な滞留は Phase 2。

これを受けて、PoC は **市販 SwitchBot 人感センサー（PIR 方式）＋ SwitchBot Hub 2 ＋ Webhook 受信**に切替（2026-05-29 ユーザー判断）。
v2 もこの方針に追随し、来場検知のハードウェア層を「自作」から「市販 + クラウド」に再定義する必要がある。

なお、データの保存先・受信エンドポイントの所在についても複数選択肢があり、本 ADR でまとめて決定する。

## 決定

来場検知センサーのデータ取得・保存・公開は以下の構成で運用する:

### 1. ハードウェア: 市販 SwitchBot 人感センサー + Hub 2 を採用

- センサー: SwitchBot 人感センサー（PIR 方式、カメラ非搭載）
- ゲートウェイ: SwitchBot Hub 2
- 自作 LiDAR（VL53L8CX + ESP32）は **PoC・MVP では採用しない**。`apps/firmware/` 配下の旧設計は本 ADR をもって deprecated とし、現物コードは `03_PoC実施/実証実験/03_ハードウェア_旧_LiDAR自作案/` にアーカイブ済

### 2. 受信方式: SwitchBot Webhook（プッシュ型） を採用

- SwitchBot クラウドが検知イベント発生時に POST する Webhook URL を `apps/web` 側に持つ
- ポーリング方式は採らない（取りこぼし・コスト・実装複雑度の観点で劣る）

### 3. 受信エンドポイントの所在: `apps/web` の Next.js Route Handler に同居

- 既存スタック（[ADR-008](008-nextjs-route-handlers.md)）に従い `POST /api/sensors/switchbot/webhook` を実装
- 別アプリ（独立した `apps/sensor-ingest` 等）には分離しない（後述の代替案で却下理由）

### 4. データ保存: Cloud SQL（PostgreSQL）の events テーブルに統合

- 新規 enum 値 `event_type='presence'` を追加
- センサーマッピング用 `sensor_devices` テーブルを新設（school_id 必須、RLS 有効）
- 第三者ホスト DB（Turso、Supabase、Neon 等）は v2 では採用しない。PoC リード時に LP 側で Turso を使ったのは「LP リポジトリで間に合わせる」ための過渡的措置であり、v2 では [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md) に従い Cloud SQL に集約する

### 5. 認可: 共有シークレット + Secret Manager

- SwitchBot Webhook は HMAC 署名を必須化していないため、URL ?key=… or X-Webhook-Key ヘッダの共有シークレットで認可
- シークレットは Secret Manager に保管（[CLAUDE.md ルール 5](../../CLAUDE.md)）。コード/環境変数に直書き禁止
- IP allowlist は SwitchBot 側の IP 安定保証が無いため不採用、シークレット強度で担保

### 6. 公開時の透明性要件

- LP・ダッシュボード・月次レポート全てに「**カメラを使用しません / PIR 方式の動き検知 / 個人を識別する情報は記録しません**」を明示
- F13 受け入れ条件 §3.2「カメラ非使用バッジ」「月次レポート脚注」で具体化

### 7. PoC 期間中の暫定運用（LP リポジトリ）との関係

- 2026-06-01〜09-30 の PoC 期間は LP リポジトリ（`06_LP/edix-lp/`）の Turso ベース最小実装を使用
- v2 移植は PoC 終了後（2026-10-01〜）。F13 §「旧 LP リファレンス実装」で移行ルートを定義済
- v2 側で受信開始後、PoC 期間データは Cloud SQL に一括移行し、LP 側エンドポイントは無効化

## 検討した代替案

### 代替 A: 自作 LiDAR を継続採用（VL53L8CX × 4 + ESP32 × 4 + 自作筐体）

- 却下理由: PoC リードタイム不足（学校設置・LAN 申請・物理セットアップに 1 週間以上）
- 副次理由: 量産・保守の知見が薄い段階で 100 校規模スケールを語るのは過剰
- 副次理由: 滞留秒数の厳密計測は MVP の効果指標としてオーバースペック（時間帯別の動き検知で広告主月次レポートは成立する）
- 副次理由: PoC 後に「やはり滞留秒数が必要」となれば Phase 2 で LiDAR を再導入する余地は残る（本 ADR は MVP に限定した却下）

### 代替 B: SwitchBot をポーリング方式（API v1.1 デバイス状態取得）で取得

- 却下理由: SwitchBot API のデバイス状態取得は「現在値のみ」で履歴は限定的、取りこぼしが発生する
- 副次理由: Cloud Run 上の常駐ポーリングは Cloud Run の課金モデル（リクエスト単位）と相性が悪い。Cloud Run Jobs での定期実行に分離するなら追加複雑度が大きい
- 副次理由: イベント到達遅延が小さくない（数十秒〜分単位の状態反映遅延がありうる）

### 代替 C: 受信を独立アプリ `apps/sensor-ingest` に分離

- 却下理由: 1 PR ≤500 行の規律下で apps の新設は追加コストが高い（Dockerfile / Terraform / vitest / Sentry 設定がそれぞれ必要）
- 副次理由: 受信ロジック・Drizzle スキーマ・RLS コンテキスト設定は apps/web と共有したい。`packages/` に切り出せば apps/web からも再利用できるが、それは内部リファクタの話で外形分離は不要
- 副次理由: 将来トラフィックが apps/web に比して大きくなった段階で分離判断する余地は残る（本 ADR は MVP 段階の所在のみ確定）

### 代替 D: Turso（libSQL／SQLite 互換ホスト DB）を v2 でも採用

- 却下理由: [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md) との二重管理になる。データ集計（F08 ダッシュボード）が JOIN を跨ぐとアプリ側合成になり PII マスキング境界が曖昧化
- 副次理由: RLS による school_id テナント分離（[ADR-019](019-rls-two-layer-tenant-isolation.md)）は Cloud SQL Postgres の特性。SQLite には RLS 相当が無い
- 副次理由: 監査ログのハッシュチェーン（NFR04）は events と同一トランザクションで書きたい
- 副次理由: Turso のロックイン（libSQL extension 等）を MVP 段階で背負わない

### 代替 E: SwitchBot から Google Sheets に直接送って Looker Studio で可視化

- 却下理由: 校務・広告主データと統合した可視化が不可能（[F08](../requirements/functional/F08-effect-dashboard.md) の AI 効果コメント自動生成 [F08 受け入れ条件] が成立しない）
- 副次理由: PII 境界が曖昧（誰が見ているか不明な Sheet を共有することになる）
- 副次理由: RLS 不在で system_admin / school_admin の権限差を表現できない

### 代替 F: 公開してから決める（決定先送り）

- 却下理由: PoC で取得したデータ形式が v2 移植時に大きく揺らぐと、PoC データの再利用ができなくなる
- 副次理由: 公開済の対外資料（LP / 月次レポート見本 / 申込書）が「人感センサー（PIR 方式）」の表現で整合済なので、ハードウェア層の決定を先送りすると対外整合性が崩れる

## 結果（Consequences）

### 良い影響

- PoC 開始までのリードタイムが 3 日に圧縮（自作 LiDAR 案では実質不可能だった）
- v2 のスタック構成（Next.js + Cloud SQL + Drizzle + RLS）に過不足なく統合できる
- 「カメラを使わない・個人を識別しない」というプライバシー透明性を公開しやすい（SwitchBot 公式仕様で説明できる）
- 自作筐体の量産・保守・故障対応のコストが消える
- センサーの増設・撤去がアプリのリリースを伴わずに `sensor_devices` テーブルへの行操作で完結

### 悪い影響 / リスク

- **市販品ロックイン**: SwitchBot の Webhook 仕様変更・サービス停止リスク。Hub 2 のクラウド依存は不可避
  - 緩和策: payload を素のまま `payload.raw` に保管し、将来別ベンダーへ移行する際の正規化レイヤーを薄く保つ
- **滞留秒数の喪失**: PIR は瞬間検知のため、F07 の `dwell` event_type を埋める情報源が一時的に不在
  - 緩和策: Phase 2 で滞留が必要になった場合、市販の ToF センサー / カメラ画像認識を Webhook 互換で接続するか、専用ハードを再評価
- **共有シークレット運用**: HMAC 署名がないため、シークレット漏洩 = 偽 POST 受け入れ
  - 緩和策: Secret Manager 半年ローテーション、Sentry での `unknown_device` 急増監視、device_mac 未登録は events に書き込まない設計で被害局所化
- **device_mac → school_id 解決失敗時の運用負荷**: 新規センサー設置時に学校側にも作業（device_mac の連絡）が発生
  - 緩和策: F13 §3.4「取り込み失敗ビュー」から 1-click で登録する UX 提供
- **SwitchBot 側の Webhook 到達遅延**: ピーク帯で数秒の遅延が発生しうる
  - 緩和策: `payload.detected_at_ms` を SwitchBot 由来時刻として保存し、受信時刻 `received_at` と差分監視

### トレードオフ

- 「自作の自由度 vs 市販の信頼性」のうち **市販の信頼性** に振った設計
- 「滞留秒数の厳密計測 vs 動き検知の運用安定性」のうち **動き検知の運用安定性** に振った設計
- 「マルチベンダー柔軟性 vs 単一ベンダーシンプル運用」のうち **単一ベンダーシンプル運用** に振った設計（payload.raw 保管で将来切替余地は残す）
- 「PoC 期間 LP / v2 二重実装の整合 vs PoC 用に LP 内で完結」のうち **後者を一時許容**（PoC 終了後に v2 単一化、F13 末尾に移行手順）
- 将来 ISMAP・物理分離・滞留秒数厳密化が必要になれば、本 ADR を Superseded として再評価可能
