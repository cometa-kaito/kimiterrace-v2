# Terraform — kimiterrace-v2 GCP IaC

GCP インフラを Terraform で管理する。**本 PR は雛形のみ。`terraform apply` は対象外**。
方針は [ADR-009](../../docs/adr/009-terraform.md) を参照。

> ⚠️ CLAUDE.md ルール8 により、**コンソールでの直接変更は緊急時のみ**。
> 通常変更はすべてここで PR を出す。

---

## ディレクトリ構成

```
infrastructure/terraform/
├── README.md                      # このファイル
├── versions.tf                    # terraform / provider バージョン制約
├── providers.tf                   # google / google-beta provider
├── backend.tf                     # GCS remote state (template)
├── variables.tf                   # 共通入力変数
├── outputs.tf                     # 共通 output
├── modules/
│   ├── cloud_run/                 # Next.js web 用 (ADR-002, ADR-008)
│   ├── cloud_sql/                 # PostgreSQL 16 + pgvector (ADR-001, ADR-007)
│   ├── identity_platform/         # IDP tenant (ADR-003)
│   ├── secret_manager/            # secret + IAM (CLAUDE.md ルール5)
│   └── network/                   # VPC + private service connection
└── envs/
    ├── prod/main.tf               # 本番ルート (project: signage-v2-prod)
    ├── staging/main.tf            # ステージング (project: signage-v2-staging)
    └── dev/main.tf                # 開発 (project: signage-v2-dev, Cloud SQL は docker-compose 代替)
```

すべてのモジュールは `enabled = false` で雛形化されており、`terraform plan`
しても**リソースは作られない**。Phase 開発で値を詰めて `enabled = true` に切り替える。

---

## Prerequisites

- gcloud CLI（認証済み: `gcloud auth login` + `gcloud auth application-default login`）
- Terraform `>= 1.9.0`（`tfenv` 推奨）
- 対象 GCP project の `roles/owner` または `roles/editor` 相当
- 必須 API 有効化済み: Cloud Run, Cloud SQL, Identity Platform, Vertex AI, Secret Manager, VPC

---

## State backend bucket の手動作成

remote state を保存する GCS bucket は **Terraform 管理外**（chicken-and-egg のため）。
一度だけ手動で作る。

```bash
# 例: prod project
gcloud config set project signage-v2-prod

gsutil mb -p signage-v2-prod -l asia-northeast1 -b on gs://signage-v2-tf-state

# バージョニング有効化（state ロールバックのため必須）
gsutil versioning set on gs://signage-v2-tf-state

# パブリックアクセス防止
gsutil pap set enforced gs://signage-v2-tf-state
```

env ごとに project / bucket を分けるのが理想だが、雛形段階では prefix で
論理分離（`envs/prod`, `envs/staging`, `envs/dev`）する。

---

## 認証（Workload Identity Federation）

CLAUDE.md ルール5 により **service account JSON キー禁止**。
CI（GitHub Actions）からの認証は Workload Identity Federation を使う。

**本 PR では variable 宣言のみ**。実体（pool / provider / SA binding）は手動か
別 PR で追加する。手順案:

```bash
# Workload Identity Pool
gcloud iam workload-identity-pools create github-pool \
  --location=global --project=signage-v2-prod

# GitHub provider
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github-pool \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository"

# SA に impersonation 許可（リポジトリ限定）
gcloud iam service-accounts add-iam-policy-binding terraform@signage-v2-prod.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/<NUM>/locations/global/workloadIdentityPools/github-pool/attribute.repository/cometa-kaito/kimiterrace-v2"
```

ローカル開発からは `gcloud auth application-default login` で十分。

---

## 標準フロー

```bash
cd infrastructure/terraform/envs/prod      # または staging / dev

# 初回のみ
terraform init

# 差分確認（雛形段階は必ず "No changes" になる想定）
terraform plan

# 適用（**本 PR スコープ外**。人間判断で別途実施）
terraform apply
```

PR では `terraform plan` の結果を貼る。Phase 開発の自動化は CI ジョブ追加で対応予定。

---

## ローカル開発との境界

- **dev env**: Cloud Run / Cloud SQL を **GCP 上に作らない**。
  ローカルは [`infrastructure/docker/`](../docker/) の docker-compose
  （postgres + pgvector + Cloud SQL Auth Proxy 不要構成）を使う。
- **staging env**: 統合テスト用。実体は Phase 開発で生成。
- **prod env**: 本番。HA / Private IP / CMEK は Phase 後半で導入。

---

## スコープ外（Phase 後半）

- CMEK / Cloud KMS（state / Cloud SQL の Customer-Managed Encryption Key）
- Cloud Armor（WAF）
- Cloud CDN
- VPC Service Controls
- Binary Authorization（コンテナ署名検証）
- 既存リソースの `terraform import`

これらは別 ADR + 別 PR で順次追加する。

---

## fmt / validate

CI で以下を必須化する予定（本 PR ではローカル実行のみ）:

```bash
terraform fmt -recursive -check infrastructure/terraform/
# 各 env で
( cd infrastructure/terraform/envs/prod    && terraform init -backend=false && terraform validate )
( cd infrastructure/terraform/envs/staging && terraform init -backend=false && terraform validate )
( cd infrastructure/terraform/envs/dev     && terraform init -backend=false && terraform validate )
```

---

## 関連

- [ADR-009 Terraform](../../docs/adr/009-terraform.md)
- [ADR-002 Cloud Run](../../docs/adr/002-cloud-run-vs-functions.md)
- [ADR-001 PostgreSQL](../../docs/adr/001-postgres-vs-firestore.md)
- [ADR-003 Identity Platform](../../docs/adr/003-identity-platform.md)
- [CLAUDE.md ルール5](../../CLAUDE.md) — Secret Manager + Workload Identity
- [CLAUDE.md ルール8](../../CLAUDE.md) — Terraform 強制
