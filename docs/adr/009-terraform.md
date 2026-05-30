# ADR-009: Terraform を採用、Pulumi を却下

- 状態: Proposed
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-002 (Cloud Run)](002-cloud-run-vs-functions.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-003 (Identity Platform)](003-identity-platform.md), [NFR07 コンプライアンス](../requirements/non-functional/NFR07-compliance.md), [CLAUDE.md ルール8 (Terraform 化)](../../CLAUDE.md)

## 文脈

公立校データを 10 年保管し、Disaster Recovery 時に **コードから完全再現できる**ことがデータ保護要件の根幹（[CLAUDE.md ルール8](../../CLAUDE.md)）。GCP リソース（Cloud Run / Cloud SQL / Identity Platform / IAM / ネットワーク / Secret Manager）を IaC で管理する手段を選定する。

要求:

- **宣言的に全 GCP リソースを記述**し、コンソール手動変更を排除（[ルール8](../../CLAUDE.md) NG: 「これだけは手動でいい」の積み重ね）。
- **`plan` を PR に提示**してレビュー可能にし、`apply` は main merge 後の自動か手動承認。
- **state を安全に共有**（GCS バックエンド + ロック）。
- **GCP プロバイダの成熟度**（Cloud SQL / Identity Platform / WIF 等を網羅）。
- **監査・再現性**（[NFR07](../requirements/non-functional/NFR07-compliance.md)）。

選択肢:

- **Terraform**（HCL）
- Pulumi（汎用言語: TS/Go 等）
- Google Cloud Deployment Manager
- gcloud スクリプト / 手動

## 決定

**Terraform を採用**し、Pulumi を却下する。

- **構成**: `infrastructure/terraform/` 配下に module（cloud_run / cloud_sql / identity_platform / WIF 等）+ envs（dev/staging/prod）。state は **GCS バックエンド**で共有・ロック。
- **CI 連携**: PR で `terraform plan` を自動投稿してレビュー（[ルール8](../../CLAUDE.md)）。`apply` は main merge 後の自動、または手動承認。
- **GCP 認証**: Workload Identity Federation（[ADR-003](003-identity-platform.md) と同じく JSON キー禁止 = [ルール5](../../CLAUDE.md)、PR #90 で WIF module 実在）。
- 既に root .tf 整理（PR #85）/ providers + GCS state + 5 module + 3 env 雛形（PR #66）/ cloud_sql deletion_protection 変数化（PR #80）/ identity_platform module（PR #84）が着地済。

決め手:

- **宣言的 HCL** が IaC の「望ましい状態」を素直に表現し、`plan` の差分がレビューしやすい。
- **GCP プロバイダの成熟度**: Cloud SQL / Identity Platform / IAM / WIF を広くカバー。
- **エコシステム・運用標準**: module レジストリ・周辺ツール・学習リソースが厚く、チームの標準化が容易。
- **`plan`/`apply` の分離**が PR レビュー（[ルール8](../../CLAUDE.md)）+ 監査（[NFR07](../requirements/non-functional/NFR07-compliance.md)）に直結。

## 検討した代替案

### 代替 A: Pulumi（汎用言語 IaC）
- 却下理由: 汎用プログラミング言語（TS 等）でインフラを書けるのは強力な一方、**ループ・条件・抽象化の自由度が IaC の「宣言的に望ましい状態を固定する」性質と衝突**しやすく、レビュー時に差分の意味が読みにくくなるリスク。公立校データ基盤では「再現性と可読性」を最優先したい。
- 副次理由: state バックエンド・運用ツールチェーンの標準化・人材確保で Terraform に分がある。
- 補足: アプリ側（[ADR-008](008-nextjs-route-handlers.md)）と同じ TS で書ける利点はあるが、IaC は「コードの少なさより差分の明快さ」を優先する判断。

### 代替 B: Google Cloud Deployment Manager
- 却下理由: GCP 専用で将来の可搬性・エコシステムが弱く、実質的に非推奨方向。Terraform の GCP プロバイダで十分かつ標準的。

### 代替 C: gcloud スクリプト / 手動
- 却下理由: [ルール8](../../CLAUDE.md) に正面から反する。状態がコードに無く、DR 時の完全再現ができない。

## 結果（Consequences）

### 良い影響
- 全 GCP リソースが宣言的にコード化され、DR 時にコードから再現可能（[ルール8](../../CLAUDE.md) / [NFR07](../requirements/non-functional/NFR07-compliance.md)）。
- `terraform plan` を PR レビューに乗せられ、インフラ変更の監査証跡が残る。
- WIF で JSON キーレス認証（[ルール5](../../CLAUDE.md) / [ADR-003](003-identity-platform.md)）。
- module / env 分割で dev/staging/prod を一貫管理。

### 悪い影響 / リスク
- **state 管理の運用責任**: GCS バックエンド + ロックの設定、state ドリフト検知が必要 → `plan` を定期実行してドリフトを検知。
- **HCL の表現力の限界**: 複雑な条件分岐は HCL では冗長になりがち → module 化で吸収。
- **手動変更の誘惑**: 緊急時のコンソール変更は許容するが、終わったら必ず Terraform 化する規律（[ルール8](../../CLAUDE.md)）を運用で守る必要。

### トレードオフ
- 「Pulumi の表現力（汎用言語）vs Terraform の宣言的明快さ」のうち、IaC の可読性・再現性・監査性を最優先し **Terraform の宣言的明快さ**に振った。
- 「GCP 専用ツールの密結合 vs Terraform の標準性・可搬性」のうち **Terraform の標準性**に振った。
