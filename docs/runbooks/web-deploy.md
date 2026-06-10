# web 日常デプロイ手順（routine code deploy）

> **これは「すでに構築済みの環境へ web の新しいコードを反映する」日常デプロイの唯一の正規手順。**
> 新セッションでデプロイを頼まれたら、STATUS.md や terraform コメントや git 履歴を読み返さず **このファイルだけ** を見ること。
> 実体は `scripts/deploy/deploy-web.sh`。このファイルはその仕様書 + スクリプトが使えない時の手動手順。

関連:
- 初期構築（一回限り。2-phase apply / secret 投入 / seed Job）→ [prod-bringup-cutover.md](prod-bringup-cutover.md)（**日常デプロイには使わない**）
- DB migration の規律 → [db-migrations.md](db-migrations.md)
- build 設定の実体 → [`infrastructure/docker/cloudbuild-web.yaml`](../../infrastructure/docker/cloudbuild-web.yaml)

---

## TL;DR（1 コマンド）

```bash
# staging に反映（build → tag bump → 確認 plan → apply → 疎通）
scripts/deploy/deploy-web.sh staging --apply

# prod に反映（--apply 必須。本番 revision が切替わる）
scripts/deploy/deploy-web.sh prod --apply

# まず plan だけ見たい（apply しない。既定動作）
scripts/deploy/deploy-web.sh staging

# 既に image を build 済の sha を反映するだけ
scripts/deploy/deploy-web.sh prod <sha> --skip-build --apply

# 反映済みを疎通確認だけ
scripts/deploy/deploy-web.sh prod --verify-only
```

- 既定（`--apply` なし）は **build + tag bump + terraform plan で停止**。実際の反映には `--apply`。
- sha 省略時は現在の `HEAD` short-7。
- スクリプトは tag bump（main.tf 編集）まではするが **git commit/push はしない** → apply 後に PR で bump をコミットする。

---

## これは何で、何ではないか（bring-up との境界）

| | 日常デプロイ（このファイル） | 初期構築 bring-up（prod-bringup-cutover.md） |
|---|---|---|
| いつ | web のコードを直すたび | 環境を新規に立てる時の **一回だけ** |
| apply 範囲 | `-target=module.cloud_run` のみ | 2-phase（network/sql/secret → 全モジュール） |
| secret 投入 | 不要 | 必要（`gcloud secrets versions add`） |
| seed Job | 不要 | 必要（school/tv/ads seed） |
| migrate | **schema を変えた時だけ**（下記） | 必要 |

> ❗ schema も secret も変えていない通常のコード修正なら、必要なのは **build → web_image_tag bump → `apply -target=module.cloud_run` → 疎通** の 4 手だけ。それ以外の手順を足さない（足すから失敗して直す羽目になる）。

---

## スクリプトがやっている 4 手（手動でやる場合の正規コマンド）

`<env>` = `staging` | `prod`、`<sha>` = デプロイ対象の git short-7 sha。env 別の値は末尾の[環境リファレンス](#環境リファレンス)。

### ① image build & push（Cloud Build）

```bash
# staging（cloudbuild-web.yaml の default が staging なので _SHA と API key だけ渡す）
gcloud builds submit . \
  --project=signage-v2-staging \
  --config=infrastructure/docker/cloudbuild-web.yaml \
  --service-account=projects/signage-v2-staging/serviceAccounts/33826309713-compute@developer.gserviceaccount.com \
  --substitutions=_SHA=<sha>,_FIREBASE_API_KEY="$(terraform -chdir=infrastructure/terraform/envs/staging output -raw firebase_api_key)"

# prod（_AUTH_DOMAIN/_PROJECT_ID/_REPO/_APP_URL を prod 値で override）
gcloud builds submit . \
  --project=signage-v2-prod \
  --config=infrastructure/docker/cloudbuild-web.yaml \
  --service-account=projects/signage-v2-prod/serviceAccounts/1003674206308-compute@developer.gserviceaccount.com \
  --substitutions=_SHA=<sha>,_FIREBASE_API_KEY="$(terraform -chdir=infrastructure/terraform/envs/prod output -raw firebase_api_key)",_AUTH_DOMAIN=signage-v2-prod.firebaseapp.com,_PROJECT_ID=signage-v2-prod,_REPO=asia-northeast1-docker.pkg.dev/signage-v2-prod/kimiterrace,_APP_URL=https://app.school-signage.net
```

`NEXT_PUBLIC_*` は Next.js が build 時に client bundle へ inline するため build-arg で焼き込む。`_FIREBASE_API_KEY` は公開値だが yaml にリテラルで埋めず `terraform output` から渡す（tag race 対策）。

### ② tag bump

`infrastructure/terraform/envs/<env>/main.tf` の `local.web_image_tag` を `<sha>` に書き換える（コメント行は触らない）。

### ③ apply（Cloud Run module だけ）

```bash
terraform -chdir=infrastructure/terraform/envs/<env> apply -target=module.cloud_run -input=false
```

認証は ADC（`gcloud auth application-default login` 済の前提）。トークンを別途設定しない。

### ④ 疎通確認

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://<base>/api/health      # 期待 200
curl -fsS -I https://<base>/login | grep -i cache-control                  # private,no-cache 期待（s-maxage は退行）
```

`<base>` = staging は Cloud Run URL、prod は `https://app.school-signage.net`。

### ⑤ bump を記録（apply 後）

apply は作業ツリーの main.tf で効くが、`web_image_tag` の bump は infra 変更なので PR でコミットして記録を残す:

```bash
git add infrastructure/terraform/envs/<env>/main.tf
git commit -m "feat(infra): <env> web を <sha> へ bump（#NNN 反映）"
```

---

## 地雷チェックリスト（反映前に毎回確認）

過去に「踏んでから直した」もの。スクリプトもこの一部を自動チェックするが、人間/Claude も毎回確認する:

- [ ] **force-dynamic**: DB 状態に依存する **public ページ**（`/login` など）に `export const dynamic = 'force-dynamic'` があるか。無いと静的プリレンダ + `s-maxage` で古い UI が出る（[[ref_idp_password_floor_and_login_static_cache]]）。④ で `s-maxage` を検出したら退行。
- [ ] **schema 変更**: `packages/db/**` を触ったか。触ったなら本手順だけでは不足 → 下記「schema を変えた時」。
- [ ] **secret 増減**: 新しい secret 参照を足したか。足したなら `gcloud secrets versions add` + 全モジュール apply が要る → 下記「secret を変えた時」。
- [ ] **prod 広告**: prod の広告 `media_url` は **staging バケット参照**。差し替えは staging 側の `ginan/*.png` を上書きする（prod バケットだけでは映らない）（[[prod-ads-use-staging-bucket]]）。
- [ ] **main merge ≠ 自動デプロイ**: main に merge しても何も反映されない。反映は build/bump/apply を踏んで初めて起きる（[[prod-deploy-model]]）。
- [ ] **IdP パスワード下限**: 共通PW等は 6 文字未満にできない（Identity Platform の下限・下げ不可）（[[ref_idp_password_floor_and_login_static_cache]]）。

---

## schema を変えた時（migrate 込みデプロイ）

`packages/db/**` の migration を追加した場合は、web の前に migrate を流す:

```bash
# 1. migrate image を build（cloudbuild-migrate.yaml、_SHA は migration を含む sha）
gcloud builds submit . --project=signage-v2-<env> \
  --config=infrastructure/docker/cloudbuild-migrate.yaml \
  --service-account=projects/signage-v2-<env>/serviceAccounts/<projnum>-compute@developer.gserviceaccount.com \
  --substitutions=_SHA=<sha>

# 2. main.tf の local.migrate_image_tag を <sha> に bump → apply（migrate module）
terraform -chdir=infrastructure/terraform/envs/<env> apply -target=module.cloud_run_job_migrate -input=false

# 3. migrate Job を実行（schema/RLS/トリガ/関数 適用）
gcloud run jobs execute kimiterrace-migrate --region asia-northeast1 --project signage-v2-<env>

# 4. その後で web を通常デプロイ（このファイルの ①〜⑤）
```

ロール規律（migrator=所有者 / app=非所有）は [db-migrations.md](db-migrations.md)。

---

## secret を変えた時

新しい secret 参照を増やした/値を変えた場合のみ:

```bash
echo -n '<value>' | gcloud secrets versions add <env>-<secret-name> --data-file=- --project=signage-v2-<env>
# secret コンテナ自体を足したなら全モジュール apply（-target を外す）
terraform -chdir=infrastructure/terraform/envs/<env> apply -input=false
```

secret はコード/環境変数に置かない（CLAUDE.md ルール5）。

---

## ロールバック

直前の sha に戻すだけ（image は AR に残っているので build 不要）:

```bash
# main.tf の web_image_tag を 1 つ前の sha に戻して apply
scripts/deploy/deploy-web.sh <env> <前の-sha> --skip-build --apply
```

直前の sha は `git log --oneline -- infrastructure/terraform/envs/<env>/main.tf` の bump コミット、または Cloud Run の revision 履歴から。

---

## 環境リファレンス

| 項目 | staging | prod |
|---|---|---|
| GCP project | `signage-v2-staging` | `signage-v2-prod` |
| project number（compute SA） | `33826309713` | `1003674206308` |
| Artifact Registry repo | `asia-northeast1-docker.pkg.dev/signage-v2-staging/kimiterrace` | `asia-northeast1-docker.pkg.dev/signage-v2-prod/kimiterrace` |
| `_AUTH_DOMAIN` | `signage-v2-staging.firebaseapp.com` | `signage-v2-prod.firebaseapp.com` |
| `_APP_URL` / 疎通 base | `https://kimiterrace-web-5wkl3il5zq-an.a.run.app` | `https://app.school-signage.net` |
| terraform dir | `infrastructure/terraform/envs/staging` | `infrastructure/terraform/envs/prod` |
| tag 変数 | `local.web_image_tag`（main.tf） | `local.web_image_tag`（main.tf） |

> URL/番号が将来変わったら **この表と `scripts/deploy/deploy-web.sh` の env 設定 + `cloudbuild-web.yaml` の default** を更新する（散在させない）。
