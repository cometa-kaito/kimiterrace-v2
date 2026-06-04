# Staging 環境 bring-up runbook

> Phase 検証の残トラック（DAST / GCS IAM / Cloud Logging PII / mTLS / embedding inversion / 実負荷DoS / 受入①②④）を回すための **Entry ゲート**。
> これは **導入(本番リリース)ではない** — staging を建てて「検証を続けるための前提」を満たす作業。go/no-go を通して初めて導入に進む。

## 現状 (2026-06-04 時点・読み取り実測)

完全グリーンフィールド。**まだ何も provision されていない**:

- GCP プロジェクト `signage-v2-staging`: **未作成**
- Terraform state バケット `gs://signage-v2-tf-state`: 未確認/未作成
- GitHub Actions の WIF 変数 (`WIF_PROVIDER` / `WIF_SA_DEPLOY` / `WIF_SA_PLAN`) と secrets: **空**
- Cloud Run: prod 含め未デプロイ
- staging terraform (`infrastructure/terraform/envs/staging`): `fmt`/`validate` 緑 = **apply-ready**、WIF 以外の全モジュール `enabled=false`

## 不変の規律

- **ルール8**: infra は Terraform のみ。GCP コンソール直編集は緊急時限定（事後 Terraform 化）。
- **ルール5**: secret の**値**は Secret Manager のみ。コード/CI ログ/`.tfvars` に値を置かない。JSON キー禁止（WIF=keyless）。
- apply は **人間/CI ゲート**（`terraform apply` は人間承認 or main merge 後の CI）。

## 役割分担

| 担当 | 内容 |
|---|---|
| **人間（あなた）** | コスト/課金を伴う作成・secret 実値の投入・`apply` の承認・外部委託(#22) |
| **Claude** | terraform コード変更(`enabled` 化 + 配線 PR)・`validate`・DB マイグレーション・E2E・go/no-go ドラフト・Reviewer |

---

## A. ブートストラップ（一度きり・**人間の owner 権限**が必要）

> ここは WIF が無い＝CI が keyless apply できない段階なので、人間が直接行う。

- [ ] **A0. state バケット**: `gs://signage-v2-tf-state` を確認、無ければ作成（バージョニング有効）。prod/staging 共有。
- [ ] **A1. プロジェクト作成 + 課金**: `signage-v2-staging` を作成し billing account をリンク（**コスト発生の意思決定**）。
- [ ] **A2. API 有効化**: run / sqladmin / secretmanager / identitytoolkit / compute / servicenetworking / iam / cloudscheduler / artifactregistry / cloudkms / logging。
- [ ] **A3. WIF ブートストラップ**: `terraform -chdir=infrastructure/terraform/envs/staging apply` を **owner 権限で初回実行**（この段階で生成されるのは WIF モジュールのみ＝他は `enabled=false`）。
- [ ] **A4. Actions 変数登録**: 出力 `wif_provider_name` / `wif_deploy_sa_email` / `wif_plan_sa_email` を GitHub Actions repo variables `WIF_PROVIDER` / `WIF_SA_DEPLOY` / `WIF_SA_PLAN` に設定（`gh variable set` 可）。以降の apply は CI が keyless で実行。

---

## B. モジュール有効化（依存順 / `enabled=false→true`）

> コード変更(flip + 配線)は **Claude が PR**、apply 承認は人間/CI。各 module のコメント(`envs/staging/main.tf`)が要配線を明記。

- [ ] **B1. network** — VPC / サブネット / **Cloud NAT**（閉域 egress の前提、ADR-021。NAT 無しで weather Job を立てると plan が fail-fast）
- [ ] **B2. secret_manager** — secret コンテナ作成 → **人間が値を投入**（`DATABASE_URL` / Identity Platform 設定 / JWT 秘密 / `SWITCHBOT_WEBHOOK_SECRET` / Sentry DSN 等、ルール5）
- [ ] **B3. cloud_sql** — Postgres16 + pgvector（staging tier `db-custom-1-3840`, `deletion_protection=false`）
- [ ] **B4. identity_platform** — 有効化 + サインインプロバイダ設定（email/password）
- [ ] **B5. cloud_run** — web 本体（`image` / `vpc_connector` / secret 参照 / accessor SA を配線）
- [ ] **B6. Cloud Run Jobs** — embedding(#416) / weather(#128) / reports(#430)。`image` / `vpc_connector` / `database_url_secret_id` / `report_bucket` を配線
- [ ] **B7. report_storage / upload_storage** — GCS バケット（生徒 PII 素材ゆえ upload は **CMEK 推奨**、writer SA を限定付与＝ルール5 最小権限）
- [ ] **B8. logging_iam** — `log_viewer_members`（運用者グループ + breakglass）を設定（ADR-029。公開ルートの秘匿値が載る request log の閲覧限定）

---

## C. デプロイ後（検証の前提を満たす）

- [ ] **C1. DB マイグレーション** 適用 → [db-migrations.md](db-migrations.md)（staging `DATABASE_URL`）
- [ ] **C2. アプリ image** を Cloud Run にデプロイ + スモーク確認
- [ ] **C3.（任意）実 Vertex / PII 有効化** — #289（職員氏名 piiEntries 供給ゲート）は close 済。コスト判断の上で有効化

---

## D. これで Phase 検証の残トラックが実行可能に

DAST(ZAP) / GCS IAM 実証 / Cloud Logging PII 走査 / mTLS / embedding inversion / 実負荷DoS / requireRole E2E / 受入①機能・②UI-UX・④非機能 → **go/no-go 判定**（[test-strategy.md](../testing/test-strategy.md) §1）→ **導入(人間)**。
backlog チェックリストは umbrella **#243** コメント参照。

## コスト / ロールバック

staging は `deletion_protection=false` / `force_destroy=true`（recreate 容易、Issue #70）。検証が一巡したら `terraform destroy` で課金停止可。

## 外部委託（並行・任意）

- **#22**[Human] ペネトレ業者3社見積（MBSD / GMOイエラエ / LAC 等）。本プロジェクトは Claude 内部ペネトレを導入前ゲート化済だが、第三者監査を入れるならここで依頼。

## 参照

ADR-021(閉域 egress) / ADR-029(logging IAM) / ADR-024(upload) / ルール5・8 / `envs/staging/main.tf` 各モジュールコメント。
