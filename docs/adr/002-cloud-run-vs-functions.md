# ADR-002: Cloud Run を採用、Cloud Functions を捨てる

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-008 (Route Handlers)](008-nextjs-route-handlers.md), [ADR-009 (Terraform)](009-terraform.md), [ADR-014 (観測)](014-observability.md), [NFR01 パフォーマンス](../requirements/non-functional/NFR01-performance.md), [CLAUDE.md スタック表](../../CLAUDE.md)

## 文脈

V1 はバックエンドロジックを **Cloud Functions（`httpsCallable`）** で実装し、フロントは Firebase Hosting に載せていた。V2 は **Next.js 16（App Router）を SSR + Server Actions** で動かす（[ADR-008](008-nextjs-route-handlers.md)）。このアプリの実行基盤を確定する必要がある。

考慮点:

- **フル SSR の Next.js を素直にホストできること**: App Router の SSR / Server Components / Server Actions / Route Handlers / middleware を 1 つの実行単位で動かしたい。
- **単一デプロイ単位 + RLS コンテキスト一元化**: 認証 + `SET LOCAL`（[ADR-019](019-rls-two-layer-tenant-isolation.md)）を 1 サービスに閉じ込め、テナント越境のリスク面を増やさない。
- **コールドスタートと常時性**: サイネージが常時表示・教員が随時編集するため、極端なコールドスタートは避けたい。
- **GCP ネイティブ統合**: Cloud SQL 接続（[ADR-001](001-postgres-vs-firestore.md)）、Secret Manager（[ルール5](../../CLAUDE.md)）、Cloud Logging / Trace（[ADR-014](014-observability.md)）、Workload Identity。
- **再現可能なインフラ**: すべて Terraform 管理（[ADR-009](009-terraform.md)）。

選択肢:

- **Cloud Run（コンテナ）**
- Cloud Functions（2nd gen）
- GKE（Kubernetes）
- Firebase Hosting + Cloud Functions（V1 構成の継続）

## 決定

**Cloud Run（asia-northeast1、コンテナ）を実行基盤に採用**し、Cloud Functions を捨てる。

決め手:

- **フル Next.js SSR をコンテナで素直にホスト**: App Router 全機能（SSR / Server Actions / Route Handlers / middleware）が単一コンテナで動く。Functions の「関数単位」粒度はモノリシックな SSR アプリと相性が悪い。
- **単一デプロイ単位**: API（[ADR-008](008-nextjs-route-handlers.md)）も UI も 1 コンテナ。認証 + RLS コンテキスト設定を 1 サービスに集約でき、ビルド・観測・Secret 取得が一経路。
- **min-instances でコールドスタート緩和**: Cloud Run は最小インスタンス数を設定でき、常時性を確保（[NFR01](../requirements/non-functional/NFR01-performance.md) / Terraform 管理）。
- **GCP 統合 + ポータビリティ**: Cloud SQL Connector / Secret Manager / Workload Identity / Cloud Logging とネイティブ統合しつつ、コンテナなので最悪の移行経路（他コンテナ基盤）も残る。
- **スケール特性**: リクエスト駆動オートスケール + concurrency 設定で、学校無料モデルのコスト効率に合う（アイドル時はゼロ〜min-instances）。

## 検討した代替案

### 代替 A: Cloud Functions（2nd gen）
- 却下理由: 関数単位の実行モデルが Next.js のフル SSR と噛み合わない。App Router を Functions に載せるには adapter 等の無理が出て、middleware / Server Components の取り回しが複雑化。
- 副次理由: API を関数ごとに分けると、認証 + `SET LOCAL`（[ADR-019](019-rls-two-layer-tenant-isolation.md)）の設定箇所が分散し、テナント越境のリスク面が広がる（[ADR-008](008-nextjs-route-handlers.md) の Hono 却下と同じ論拠）。

### 代替 B: GKE（Kubernetes）
- 却下理由: 運用負荷（クラスタ管理・ノードプール・アップグレード）が本システムの規模・チーム体制に対して過大。Cloud Run のマネージド性で十分。
- 補足: 将来、複雑なワークロード分離やサイドカーが必要になれば再評価余地。

### 代替 C: Firebase Hosting + Cloud Functions（V1 構成の継続）
- 却下理由: [ADR-001](001-postgres-vs-firestore.md) で Firestore を捨て GCP ネイティブへ全改修する方針と一体。Hosting + Functions は Firebase エコシステム前提で、Cloud SQL / Workload Identity / Terraform 一元管理（[ADR-009](009-terraform.md)）と統合が弱い。

## 結果（Consequences）

### 良い影響
- フル Next.js SSR を単一コンテナで運用でき、API（[ADR-008](008-nextjs-route-handlers.md)）+ UI + 認証 + RLS コンテキストが 1 経路に集約。
- min-instances でコールドスタートを抑えつつ、アイドル時はスケールダウンしてコスト効率を確保。
- Cloud SQL / Secret Manager / Cloud Logging / Workload Identity とネイティブ統合（[ルール5](../../CLAUDE.md) / [ADR-014](014-observability.md)）。
- コンテナ前提でポータビリティと Terraform 再現性（[ADR-009](009-terraform.md)）を担保。

### 悪い影響 / リスク
- **コールドスタートのコスト/レイテンシのトレードオフ**: min-instances を増やすと常時課金、減らすとコールドスタート → [NFR01](../requirements/non-functional/NFR01-performance.md) と突合して調整。
- **Cloud SQL 接続管理**: サーバレスからの接続数上限に注意。Cloud SQL Connector / プーラ設計が必要（[ADR-001](001-postgres-vs-firestore.md) と共通の課題）。
- **コンテナビルド/イメージ管理**: Functions より CI のビルド工程が増える（Artifact Registry / イメージ脆弱性スキャン）→ CI に組み込み。

### トレードオフ
- 「関数単位の細粒度 vs 単一コンテナの一体性」のうち、フル SSR アプリ + RLS 一元化のため **単一コンテナの一体性**に振った。
- 「フルマネージド（Functions/Run）vs 自己管理（GKE）」のうち、運用負荷最小化のため **マネージドな Cloud Run**に振った。
- 「Firebase 継続の手軽さ vs GCP ネイティブの統合・可監査性」のうち、[ADR-001](001-postgres-vs-firestore.md) と一体で **GCP ネイティブ**に振った。
