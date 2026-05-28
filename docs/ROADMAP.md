# キミテラス v2 ロードマップ（12週 + 準備1週）

旧 Firebase 構成から GCP ネイティブへの全改修。詳細は [CLAUDE.md](../CLAUDE.md) 参照。

---

## 全体カレンダー

| 週 | フェーズ | 主な成果物 |
|---|---|---|
| W0 | 準備 | 要件・ADR・スキーマ初稿、外部発注開始 |
| W1 | インフラ起動 | GCP プロジェクト、Terraform 雛形、Cloud SQL 起動 |
| W2-3 | データ基盤 | PostgreSQL スキーマ確定、RLS、マイグレーション |
| W4 | 認証基盤 | Identity Platform、ユーザー移行スクリプト |
| W5-6 | API 層 | Next.js Route Handlers、Drizzle 接続、認可ミドルウェア |
| W7-8 | フロント | UI 接続、SSE ストリーミング、サイネージ |
| W9 | サイネージ端末 | firmware 更新、JSON 配信切替 |
| W10 | AI 機能 | pgvector embedding、Gemini チャット、RAG |
| W11 | 運用基盤 | 監査ログ、バックアップ、BigQuery、監視 |
| W12 | 受け入れ・切替 | UAT、ペネトレテスト結果反映、本番切替リハーサル |

---

## 並行する人間タスク

| 週 | 人間タスク |
|---|---|
| W0 | gcloud/Terraform インストール、GCP プロジェクト作成、Wi-Fi 方式問合せ、ペネトレ業者見積依頼 |
| W1-2 | GCP 課金監視設定、IAM 設計レビュー |
| W3-4 | 個人情報取扱規程・プライバシーポリシー最終化（Claude が初稿） |
| W5-6 | サイバー保険申込、委託先管理表確定 |
| W7-8 | ペネトレ業者発注確定 |
| W9-10 | 学校向け移行説明資料作成 |
| W11 | ペネトレ実施 |
| W12 | UAT 立ち会い、切替判断 |

---

## W0 詳細（今週）

### 完了条件

- [ ] kimiterrace-v2 リポジトリ稼働（CI 緑、branch protection 設定済み）
- [ ] CLAUDE.md・STATUS.md・ROADMAP.md 完成
- [ ] docs/requirements/ に F01-F07 + NFR01-NFR06 のドラフト
- [ ] docs/adr/ に 001-014 の初稿
- [ ] docs/architecture/data-model.md に PostgreSQL ER 図（Mermaid）
- [ ] docs/architecture/threat-model.md（STRIDE）ドラフト
- [ ] packages/db/schema/ に DDL 初稿
- [ ] GitHub Issues #1-#30 に W1 以降のタスク登録
- [ ] [人間] GCP プロジェクト作成 + gcloud/Terraform インストール
- [ ] [人間] 県教委への Wi-Fi 方式問合せ送信

### 完了予想

W0 終了時（2026-06-04 想定）

---

## W1 詳細（次週、参考）

### 主タスク

1. Terraform で GCP プロジェクトを宣言的管理に移行
2. VPC + Cloud SQL（Private IP）構築
3. Identity Platform セットアップ
4. Cloud Run 最小構成デプロイ（Hello World）
5. Cloud Logging + Cloud Monitoring 基本設定
6. GitHub Actions に terraform plan / Cloud Run preview デプロイ追加

### 完了条件

- [ ] `terraform plan` が CI で実行されている
- [ ] dev 環境で「公開された URL から Hello が返る」
- [ ] Cloud SQL に空のスキーマがマイグレーションで適用される
- [ ] Identity Platform に test user で sign in できる

---

## マイルストーン KPI

| マイルストーン | 目標日 | 達成基準 |
|---|---|---|
| 基盤構築完了 | 2026-06-25 (W4) | 認証＋DB＋API のスケルトンが疎通 |
| 機能実装完了 | 2026-07-30 (W9) | 全機能が dev/staging で動く |
| AI 機能完了 | 2026-08-06 (W10) | RAG チャットが本番相当のデータで動く |
| 受け入れ完了 | 2026-08-20 (W12) | ペネトレ指摘事項解消、UAT 通過 |
| 本番切替 | 2026-08-22-23 (週末) | DNS 切替、並行運用開始 |
| 旧 Firebase 停止 | 2026-09-05 (切替+2週) | 並行運用期間終了 |

---

## スコープ調整方針

工程遅延時に削る順序（守るべき優先度）:

| 優先度 | カテゴリ | 削れる |
|---|---|---|
| 最優先（削らない） | セキュリティ・監査・データ移行・既存機能の完全互換 | × |
| 優先 | AI チャット中核機能（RAG、ストリーミング） | △ MVP に縮める可 |
| 通常 | AI 補助機能（要約、自動生成） | ○ |
| 任意 | 高度な分析ダッシュボード、BigQuery 連携 | ○ ポストローンチへ |

「速度のために安全を削る」は**絶対にしない**。
