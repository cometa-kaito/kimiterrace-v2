# Runbook: GitHub Actions ↔ GCP (Workload Identity Federation)

GitHub Actions が GCP リソースを操作する際の認証経路。**SA JSON キーは絶対に配布しない** (CLAUDE.md ルール 5)。OIDC トークン → WIF Provider → Service Account impersonation で完結させる。

対応 Terraform: [`infrastructure/terraform/modules/workload_identity_federation/`](../../infrastructure/terraform/modules/workload_identity_federation/)

---

## 全体像

```
GitHub Actions Runner
   │  ① OIDC token (issuer: token.actions.githubusercontent.com)
   ▼
google-github-actions/auth@v2
   │  ② STS exchange (Workload Identity Pool / Provider)
   ▼
GCP STS short-lived federated token
   │  ③ SA impersonation (roles/iam.workloadIdentityUser)
   ▼
gha-plan-<env>@<project>.iam.gserviceaccount.com   (read-only)
gha-deploy-<env>@<project>.iam.gserviceaccount.com (deploy)
```

---

## 手順

### 1. Terraform で WIF をプロビジョン

各環境ごとに 1 回だけ実施する。

```bash
cd infrastructure/terraform/envs/dev   # or staging / prod
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

出力例:

```
wif_provider_name   = projects/123456789/locations/global/workloadIdentityPools/github-dev/providers/github-dev
wif_deploy_sa_email = gha-deploy-dev@signage-v2-dev.iam.gserviceaccount.com
wif_plan_sa_email   = gha-plan-dev@signage-v2-dev.iam.gserviceaccount.com
```

### 2. GitHub Actions の Repository Variables に登録

Settings → Secrets and variables → Actions → **Variables** タブ。

| 変数名 | 値 | 用途 |
|---|---|---|
| `WIF_PROVIDER` | `wif_provider_name` の値 | `google-github-actions/auth@v2` の `workload_identity_provider` |
| `WIF_SA_PLAN`  | `wif_plan_sa_email`   の値 | PR / 検証 jobs (read-only) |
| `WIF_SA_DEPLOY`| `wif_deploy_sa_email` の値 | main マージ後の deploy jobs |

> **Secrets ではなく Variables を使う**。値は機密ではなく、ログに出ても問題ない（漏れても impersonate には GitHub OIDC token が必要）。

環境を分ける場合は GitHub Environments (`dev` / `staging` / `prod`) を作成し、Variables を Environment スコープに置く。

### 3. 検証

push して `CI / GCP Auth (WIF)` ジョブが green ならば疎通 OK。

ローカルから確認したい場合:

```bash
# pool / provider が存在することを確認
gcloud iam workload-identity-pools describe github-dev \
  --location=global --project=signage-v2-dev

gcloud iam workload-identity-pools providers describe github-dev \
  --location=global --workload-identity-pool=github-dev \
  --project=signage-v2-dev

# SA に WIF impersonation が許可されていることを確認
gcloud iam service-accounts get-iam-policy \
  gha-plan-dev@signage-v2-dev.iam.gserviceaccount.com \
  --project=signage-v2-dev
```

期待される `members` (一部):

```
principalSet://iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/github-dev/attribute.repository/cometa-kaito/kimiterrace-v2
```

---

## トラブルシューティング

### `Unable to acquire impersonation credentials`

- 原因候補 1: GitHub Actions job に `permissions: id-token: write` が付いていない。
- 原因候補 2: 別リポジトリから動かしている。`attribute_condition` が `assertion.repository == "cometa-kaito/kimiterrace-v2"` で弾いている。
- 原因候補 3: SA への `roles/iam.workloadIdentityUser` バインディングが drift で消えた。`terraform apply` で復元。

### `Permission 'iam.serviceAccounts.getAccessToken' denied`

- SA email を間違えている (deploy ↔ plan)。
- `var.env_name` と GitHub Actions が指す Environment が不一致。

### Provider/pool が見つからない

```bash
gcloud iam workload-identity-pools providers describe <provider-id> \
  --location=global \
  --workload-identity-pool=<pool-id> \
  --project=<project-id>
```

存在しなければ `terraform apply` 未実施。`infrastructure/terraform/envs/<env>` で apply する。

### Rotate / 緊急遮断

WIF にはキーがないので「rotate」は不要だが、**該当リポジトリからの impersonation を即時遮断したい場合**:

```bash
gcloud iam service-accounts remove-iam-policy-binding \
  gha-deploy-<env>@<project>.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member='principalSet://iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/github-<env>/attribute.repository/cometa-kaito/kimiterrace-v2'
```

応急処置のあと **必ず Terraform 側を更新** して PR を出し直す（ルール 8 / drift 禁止）。

---

## 関連

- CLAUDE.md ルール 5 (Secret Manager のみ、JSON キー禁止)
- CLAUDE.md ルール 8 (Terraform 外のインフラ変更禁止)
- ADR-009 Terraform: [docs/adr/009-terraform.md](../adr/009-terraform.md)
- Google: <https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines-github>
