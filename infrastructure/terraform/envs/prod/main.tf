# prod 環境ルート
# staging（envs/staging/main.tf）と **構造（wiring）パリティ** を保った雛形。
# 実体生成は各モジュールの enabled = true に切替後、本番 bring-up で実行する。
#
# ★ 重要: 本ファイルは「authoring（配線記述）のみ」で、すべてのモジュールが enabled = false である。
#   ＝ どの apply を打っても **リソースは 0 個**（誤 apply は no-op）。本番リソースは下記
#   「本番 bring-up シーケンス」を人間が踏むまで一切作られない。これにより本番 bring-up は
#   「terraform を書く」ではなく「enabled=true に倒す + イメージタグを実値に + secret を投入 + apply」
#   の運用作業に縮約される（ルール8: すべて Terraform 管理、設定漂流ゼロ）。
#
# ─────────────────────────────────────────────────────────────────────────────
# 本番 bring-up シーケンス（この順で人間が実行する。各ステップは客観検証ゲートあり）
# ─────────────────────────────────────────────────────────────────────────────
# ① イメージタグ locals を **実ビルド済みタグ** に置換する
#    - locals.migrate_image_tag / web_image_tag / seed_*_image_tag / backfill_presence_image_tag /
#      jobs_image_tag の "REPLACE_AT_BRINGUP" を、prod 用に Cloud Build 済 + Artifact Registry push 済の
#      実 sha タグに置き換える（staging で実証済みの版を昇格させる）。
#    - 置換漏れ（"REPLACE_AT_BRINGUP" のまま）は enabled=true 化後の plan precondition / Job 実行で
#      fail-fast するので、本番に誤った image が出ることはない。
#
# ② prod-* secret の **値（中身）を人間が投入** する（ルール5: Terraform は値を扱わない）
#    - まず ④ の 2-phase apply の前半で secret コンテナだけ作る（下記）。
#    - その後、各 prod-* secret に値を投入する:
#        gcloud secrets versions add prod-db-app-password      --data-file=- --project=signage-v2-prod
#        gcloud secrets versions add prod-db-migrator-password --data-file=- --project=signage-v2-prod
#        gcloud secrets versions add prod-db-url-migrator      --data-file=- --project=signage-v2-prod
#        gcloud secrets versions add prod-db-url-app           --data-file=- --project=signage-v2-prod
#        gcloud secrets versions add prod-tv-poll-secret       --data-file=- --project=signage-v2-prod
#      DSN（prod-db-url-migrator / prod-db-url-app）は cloud_sql 作成後に確定する private IP を使う
#      （postgresql://<user>:<pw>@<private-ip>:5432/kimiterrace?sslmode=require）。
#      prod-tv-poll-secret は v1 LP の TV_POLL_SECRET 現値と一致させる（cutover で LP 互換ポーリング維持）。
#
# ③ モジュール enabled を **依存順** に true へ倒す（下から順に効く）:
#      1. network          （VPC / connector / PSA peering / Cloud NAT）
#      2. cloud_sql        （private IP は network の PSA peering 上に割り当て。DB user は ② の secret 値が前提）
#      3. secret_manager   （secret コンテナ作成。値投入の器）
#      4. identity_platform（職員 email/password 認証 + web SDK apiKey）
#      5. cloud_run        （web service。DATABASE_URL / TV_POLL_SECRET secret を runtime 注入）
#      6. jobs            （cloud_run_job_migrate + 各 seed Job。migrate → seed の順で実行）
#    artifact_registry / ad_media / workload_identity_federation は image/asset の器ゆえ早期に true で可。
#
# ④ **2-phase apply**（chicken-and-egg 回避。data source が読む secret 値を先に投入する）:
#      Phase 1: terraform -chdir=infrastructure/terraform/envs/prod apply -target=module.secret_manager
#               （secret コンテナだけ作成）
#      → ② で全 prod-* secret に値を投入
#      Phase 2: terraform -chdir=infrastructure/terraform/envs/prod apply
#               （残り全リソース。cloud_sql の DB user data source が ② の最新版を読める）
#
# ⑤ migrate Job → seed Job の順で実行する（DB スキーマ → テナント → 端末/広告データ）:
#      gcloud run jobs execute kimiterrace-migrate         --region asia-northeast1 --project signage-v2-prod
#      gcloud run jobs execute kimiterrace-seed-ginan-sch  --region asia-northeast1 --project signage-v2-prod
#      gcloud run jobs execute kimiterrace-seed-ginan-tv   --region asia-northeast1 --project signage-v2-prod
#    岐南 TV 端末の実 device_id / target_mac は packages/db/src/seed-ginan-tv-devices.ts の
#    GINAN_ECE_TV_DEVICES（コンパイル時同梱・稼働中 LP の tv_devices 由来）を真実とする。本番の実 device_id に
#    差し替える場合は当該ソースを更新して migrate イメージを再ビルド → ① の migrate_image_tag を bump する
#    （CLI は env で device 一覧を受けない＝改竄面を増やさない設計。SEED_GINAN_SCHOOL_NAME /
#    SEED_GINAN_DEPARTMENT_NAME のみ env 上書き可）。冪等（ON CONFLICT (device_id) DO NOTHING）ゆえ再実行安全。

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  backend "gcs" {
    bucket = "signage-v2-tf-state"
    prefix = "envs/prod"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region

  # apikeys / identitytoolkit など一部 API は user ADC 利用時に quota/billing project の明示が要る
  # （未指定だと 403 "requires a quota project, which is not set by default"）。当該 project を
  # billing/quota project として各リクエストに送る。state バケット等の既存リソースには影響なし。
  user_project_override = true
  billing_project       = var.project_id
}

provider "google-beta" {
  project = var.project_id
  region  = var.region

  user_project_override = true
  billing_project       = var.project_id
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "signage-v2-prod"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "asia-northeast1"
}

variable "repository" {
  description = "GitHub repository in owner/name form. Only OIDC tokens from this repo can impersonate the WIF SAs."
  type        = string
  default     = "cometa-kaito/kimiterrace-v2"
}

locals {
  env = "prod"

  # アプリ DB ユーザー（app）のパスワードを保持する Secret Manager secret ID（ルール5）。
  # 値（パスワード）は人間が `gcloud secrets versions add prod-db-app-password --data-file=-` で投入する。
  # 同じ ID を secret_manager（コンテナ作成）と cloud_sql（data source で参照）の両方に渡す。
  db_app_password_secret_id = "prod-db-app-password" # gitleaks:allow（secret の ID であり値ではない・ルール5値は人間投入）

  # migration（M3）用の secret ID（ルール5・値は人間投入）。
  # - migrator のパスワード（raw）: cloud_sql の google_sql_user.migrator が data source で読む。
  # - migrator の DSN（full）: migration Cloud Run Job が DATABASE_URL env として Secret Manager から注入。
  db_migrator_password_secret_id = "prod-db-migrator-password" # gitleaks:allow（secret の ID であり値ではない・ルール5値は人間投入）
  db_url_migrator_secret_id      = "prod-db-url-migrator"

  # app の DATABASE_URL（DSN）を保持する Secret Manager secret ID（ルール5・値は人間投入）。
  # Cloud Run web service が DATABASE_URL env として Secret Manager から注入する。
  db_url_app_secret_id = "prod-db-url-app"

  # TV ポーリング共有シークレット（TV_POLL_SECRET）の Secret Manager secret ID（ルール5・値は別途投入）。
  # F15/ADR-022: /api/tv/config・/api/tv/lp-config の認証。未投入だと poll route は fail-closed(401)。
  # cutover では v1 LP の TV_POLL_SECRET 現値と一致させる（LP 互換ポーリングを切らさない）。
  tv_poll_secret_id = "prod-tv-poll-secret" # gitleaks:allow（secret の ID であり値ではない・ルール5値は人間投入）

  # ゼロダウンタイム鍵ローテ（漏洩対応）の移行期だけ TV_POLL_SECRET_LEGACY として配線する prod-tv-poll-secret の
  # 旧バージョン番号。""（既定）= 単一キー運用（従来挙動）。カットオーバー手順:
  #   ①新キー値を新バージョンとして投入: gcloud secrets versions add prod-tv-poll-secret --data-file=- --project=signage-v2-prod
  #     （--data-file は値をプロセス置換/標準入力で渡し、コマンド/履歴に値を残さない。ルール5）→ 新版が latest=新キー。
  #   ② ここを旧版番号（投入直前の latest。例 "3"）に設定 → apply（web image も二重受理コードへ bump）。
  #     → TV_POLL_SECRET=latest(新)・TV_POLL_SECRET_LEGACY=旧 を両受理（無停止）。
  #   ③全 TV 端末を新キーへ更新後、ここを "" へ戻して apply → 旧キー失効。旧版は disable/destroy（gcloud secrets versions disable）。
  tv_poll_secret_legacy_version = "" # 2026-06-11 closeout: 本番モニタ3台が新キー(v4)に乗ったので旧キー(v3/漏洩値)受理を停止（73f65bf0私物は失効OK）

  # TV プロビジョニング agent 認証 共有シークレット（PROVISION_AGENT_SECRET）の Secret Manager secret ID
  # （ルール5・値は別途投入）。C方式 / PR4: /api/tv/provisioning/* の agent 認証。TV_POLL_SECRET とは別 secret。
  # 未投入だと agent route は fail-closed（未認証エージェントを到達させない）。
  provision_agent_secret_id = "prod-provision-agent-secret" # gitleaks:allow（secret の ID であり値ではない・ルール5値は人間投入）

  # portal ↔ v2 Partner API 共有シークレット（PARTNER_API_SECRET）の Secret Manager secret ID（ルール5・値は別途投入）。
  # partner-api-contract §1 / K1 効果メトリクス pull（/api/partner/*）。portal 側 Vercel env PORTAL_API_SECRET と同一値。
  # 未投入だと partner route は fail-closed(401)（未認証の portal リクエストを到達させない）。
  partner_api_secret_id = "prod-partner-api-secret" # gitleaks:allow（secret の ID であり値ではない・ルール5値は人間投入）

  # TV 死活監視の Slack incoming webhook URL の Secret Manager secret ID（ルール5・値は別途投入）。
  # PR7 / F16 §9: device_down / device_recovered を Slack に配信する URL。未投入だと Slack 送信は no-op。
  slack_webhook_url_secret_id = "prod-slack-webhook-url" # gitleaks:allow（secret の ID であり値ではない・ルール5値は人間投入）

  # ── イメージタグ（placeholder）─────────────────────────────────────────────
  # TODO(bring-up ①): "REPLACE_AT_BRINGUP" を、prod 用に Cloud Build 済 + Artifact Registry push 済の
  #   実 sha タグに置き換える（staging で実証済みの版を昇格させる）。置換漏れは enabled=true 化後の
  #   plan precondition / Job 実行で fail-fast するため、誤 image が本番に出ることはない。
  #   ★ 本番に実値を出さないため、いずれも意図的な placeholder のまま commit する（authoring 段階）。

  # migration Job が使うイメージタグ（migrate-cli + 全 seed-cli を同梱した migrate イメージ）。
  migrate_image_tag = "ea93c5f" # 2026-06-20: news_items.summary 列追加（#1087・ALTER TABLE ADD COLUMN IF NOT EXISTS summary text・additive/後方互換・RLS監査不変・resolve_magic_link 無関係）。0028-0033（news/weather/heat/snippets/calendar/air_quality・ADR-043/044/045/046）も同梱し migrate-runner が未適用分のみ冪等適用。prod Job 実行は人間専任ゲート（summary 列は適用済・prod 実 Job image=ea93c5f）

  # app 層 E2E 用テストフィクスチャ seed Job のイメージタグ（migrate イメージ + seed-staging-cli）。
  # prod では本番テナント seed を別途行うため通常は使わない（雛形のみ・enabled=false）。
  seed_image_tag = "REPLACE_AT_BRINGUP" # TODO(bring-up ①)

  # 岐南工業 電子工学科 設置済 SwitchBot を sensor_devices に登録する seed Job のイメージタグ（F13/#391）。
  seed_ginan_image_tag = "17449d2" # bring-up: migrate イメージ（全 seed-cli 同梱）を流用

  # 岐南 電子工学科 PoC の実契約サイネージ広告を登録する seed Job のイメージタグ。
  seed_ginan_ads_image_tag = "17449d2" # bring-up: migrate イメージ（全 seed-cli 同梱）を流用

  # PoC 本番(LP/Turso motion_events)の来場検知履歴を v2 events(type='presence')へ取り込む backfill Job のタグ。
  backfill_presence_image_tag = "REPLACE_AT_BRINGUP" # TODO(bring-up ①)

  # apps/jobs（天気取得 Job 等）が使うイメージタグ（jobs.Dockerfile build/push 済、F14/#128 ADR-021）。
  jobs_image_tag = "ea93c5f" # 2026-06-20: news 取得 Job に経産省 METI(Atom)フィード追加＋`<summary>`抽出＋CC BY gating(meti/mext のみ summary 保存・jst は破棄)(#1087)。warnings/heat/calendar/大気 relay(ADR-044/045/046)+weather/railway/tv-liveness は同コードで image のみ更新。prod 実 Job image=ea93c5f

  # Cloud Run web service（B5）が使う app イメージタグ（build/push 済・実 Firebase config 込み）。
  web_image_tag = "ad8a27f" # main(ad8a27f)へ復帰=7/1 の旧ブランチ 3fa8091 巻き戻り解消 + 盤面ページング#1204 + 前日コピー#1206（schema #1205 の 0036 は prod 未適用=web は新テーブル未参照で安全・人間専任 skill apply-migration 待ち・secret 無変更・疎通 health200/login private,no-cache）
}

module "network" {
  source            = "../../modules/network"
  project_id        = var.project_id
  region            = var.region
  env               = local.env
  enabled           = true        # bring-up: 2026-06-08 有効化（ユーザー承認の prod 構築）
  psa_range_address = "10.60.0.0" # connector_cidr 10.8.0.0/28 と非重複（PR #493 enable-time 対応・staging と同方針）
}

# Cloud SQL for PostgreSQL 16 + pgvector（ADR-001 / ADR-007）。
# prod は private IP only + SSL 強制 + pgvector + 自動バックアップ/PITR + REGIONAL（HA = 同期スタンバイで
# 自動 failover、10 年保管要件 ADR-001）。private IP は network の PSA peering 上に割り当てられるため、
# network_id と private_services_ready を配線し peering -> instance の順序を強制する。
# DB ユーザー（google_sql_user.app / migrator）は Secret Manager 値投入後に有効化（2-phase apply、④）。
module "cloud_sql" {
  source                 = "../../modules/cloud_sql"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true                                  # bring-up: 2026-06-08 有効化（パスワード secret 投入後）
  availability_type      = "ZONAL"                               # 2026-06-08 ユーザー判断: PoC 規模ゆえコスト優先で ZONAL（durability は backup/PITR で担保）
  deletion_protection    = true                                  # prod は誤削除防止（10 年保管要件、ルール8 / ADR-001）
  vpc_network_id         = module.network.network_id             # private IP を割り当てる VPC
  private_services_ready = module.network.private_services_ready # PSA peering 実在 signal（順序強制）

  # TODO(prod hardening): tier は本番 bring-up 時の確定事項。ここでは staging 同等値を仮置きする
  #   （アグレッシブな tier を当てずっぽうで指定しない）。実負荷見積り後に db-custom-N-M を確定すること。
  #   HA（REGIONAL）/ バックアップ世代数 / PITR 保持日数 / メンテナンスウィンドウもあわせて見直す
  #   （backup_retained_count / transaction_log_retention_days / maintenance_window_* はモジュール既定を流用）。
  tier = "db-custom-1-3840" # TODO(prod hardening): 本番 tier 確定（staging 同等の仮値）

  # アプリ DB ユーザー（app）のパスワード secret（secret_manager が作成・人間が値を投入）。
  # 2-phase apply（④）: ① -target=module.secret_manager で secret コンテナ作成 → ② 値投入 → ③ full apply で user 作成。
  app_db_password_secret_id = local.db_app_password_secret_id

  # migrator DB ユーザー（migration 実行・テーブル所有）のパスワード secret（同じ 2-phase apply）。
  migrator_db_password_secret_id = local.db_migrator_password_secret_id
}

# Secret Manager（ルール5）。Terraform はコンテナのみ作成し、値（パスワード/DSN/共有シークレット）は
# 人間が投入する（2-phase apply の前半で器を作り、②で値を入れる）。
#   gcloud secrets versions add prod-db-app-password --data-file=- --project=signage-v2-prod
# accessor SA は cloud_run / 各 Job の runtime SA 生成後（enabled 化時）にモジュール内で配線される。
module "secret_manager" {
  source     = "../../modules/secret_manager"
  project_id = var.project_id
  env        = local.env
  enabled    = true # bring-up: 2026-06-08 有効化（Phase 1 で -target・器を先に作り値を投入）
  secrets = {
    (local.db_app_password_secret_id) = {
      description = "Cloud SQL アプリ DB ユーザー（app）のパスワード。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
    (local.db_migrator_password_secret_id) = {
      description = "Cloud SQL migrator DB ユーザー（migration 実行・テーブル所有）のパスワード（raw）。値は人間が投入（ルール5）。"
    }
    (local.db_url_migrator_secret_id) = {
      description = "migrator の DATABASE_URL（DSN）。migration Cloud Run Job が DATABASE_URL env で注入。値は人間が投入（ルール5）。"
    }
    (local.db_url_app_secret_id) = {
      description = "app の DATABASE_URL（DSN）。Cloud Run web service が DATABASE_URL env で注入。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
    (local.tv_poll_secret_id) = {
      description = "TV ポーリング共有シークレット（TV_POLL_SECRET、F15/ADR-022）。Cloud Run web service が /api/tv/config・/api/tv/lp-config の認証に使う。cutover では v1 LP 現値と一致させる。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
    (local.provision_agent_secret_id) = {
      description = "TV プロビジョニング agent 認証 共有シークレット（PROVISION_AGENT_SECRET、C方式/PR4）。Cloud Run web service が /api/tv/provisioning/* の agent 認証に使う。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
    (local.partner_api_secret_id) = {
      description = "portal ↔ v2 Partner API 共有シークレット（PARTNER_API_SECRET、partner-api-contract §1）。Cloud Run web service が /api/partner/*（K1 効果メトリクス pull）の認証に使う。portal 側 Vercel env PORTAL_API_SECRET と同一値。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
    (local.slack_webhook_url_secret_id) = {
      description = "TV 死活監視の Slack incoming webhook URL（PR7/F16 §9）。tv-liveness Cloud Run Job が device_down/device_recovered の配信に使う。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
  }
}

# Artifact Registry（Docker）— migration Cloud Run Job + Cloud Run app(B5) の image 置き場（ルール8 / ADR-002）。
# イメージは `<region>-docker.pkg.dev/<project>/kimiterrace/<image>:<tag>` で push する（output image_repo_url 参照）。
module "artifact_registry" {
  source        = "../../modules/artifact_registry"
  project_id    = var.project_id
  region        = var.region
  env           = local.env
  enabled       = true # bring-up: 2026-06-08 有効化（image push の器）
  repository_id = "kimiterrace"
}

# DB migration Cloud Run Job（M3, #243）。private-IP-only な Cloud SQL へ migration を適用する on-demand Job。
# 実行: `gcloud run jobs execute kimiterrace-migrate --region asia-northeast1 --project signage-v2-prod`。
# image = AR の migrate:<tag>。DATABASE_URL = migrator DSN secret。VPC connector で private IP 到達。
# migrator user / DSN secret は人間の値投入（ルール5）が前提ゆえ、secret 未投入のうちは Job 実行が失敗する。
# prod は deletion_protection = true（モジュール既定。誤削除防止）。
module "cloud_run_job_migrate" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true  # bring-up: 2026-06-08 有効化（migrate Job）
  deletion_protection    = false # 使い捨て runner（データ非保持）ゆえ recreate 容易性優先（staging と同方針）
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.migrate_image_tag}"
  database_url_secret_id = local.db_url_migrator_secret_id
  vpc_connector          = module.network.vpc_connector_id
  grant_app_role_member  = "app" # migration 後 GRANT kimiterrace_app TO app（app login が SET ROLE できるように）
  # deletion_protection はモジュール既定 true（prod）
}

# app 層 E2E 用テストフィクスチャ seed Job（on-demand）。migrate と同モジュール/イメージを command 上書きで
# 再利用し `dist/seed-staging-cli.js` を起動する。prod では本番テナント seed を別途行うため通常未使用（雛形）。
module "cloud_run_job_seed" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = false # TODO(bring-up ③): prod では通常未使用（必要時のみ true）
  job_name               = "kimiterrace-seed"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.seed_image_tag}"
  command                = ["node", "dist/seed-staging-cli.js"] # migrate-cli でなく seed-cli を起動
  database_url_secret_id = local.db_url_migrator_secret_id      # migrator DSN（BYPASSRLS で cross-tenant seed）
  vpc_connector          = module.network.vpc_connector_id
}

# F13 (#391, ADR-020): 岐南工業 電子工学科1〜3年 設置済 SwitchBot を sensor_devices に登録する on-demand seed Job。
# command 上書きで `dist/seed-ginan-sensors-cli.js` を起動。migrator DSN で system_admin context を張って冪等 INSERT。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan --region asia-northeast1 --project signage-v2-prod`。
# 前提: 岐南テナント（学校 + 電子工学科 + 1〜3年）が既存（無ければ fail-loud）。再実行は ON CONFLICT で安全。
module "cloud_run_job_seed_ginan" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true  # bring-up: 2026-06-08 有効化（岐南センサー seed）
  deletion_protection    = false # 使い捨て seed runner（データ非保持）
  job_name               = "kimiterrace-seed-ginan"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.seed_ginan_image_tag}"
  command                = ["node", "dist/seed-ginan-sensors-cli.js"] # 岐南センサー seed を起動
  database_url_secret_id = local.db_url_migrator_secret_id            # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
}

# サイネージ広告クリエイティブの公開配信バケット（#46/#48-F）。サイネージ端末が ads.media_url を直接 GET する。
# 広告は公開掲示物（PII なし）ゆえ公開 read。prod は force_destroy = false（モジュール既定。誤削除防止）。
# 画像実体（オブジェクト）は content ゆえ Terraform 管理外（gcloud storage cp で upload）。
module "ad_media" {
  source     = "../../modules/ad_media"
  project_id = var.project_id
  location   = var.region
  env        = local.env
  enabled    = true # bring-up: 2026-06-08 有効化（広告クリエイティブ配信バケット）
  # force_destroy はモジュール既定 false（prod・誤削除防止）
}

# 岐南 電子工学科 PoC の実契約サイネージ広告（advertisers + 学校スコープ ads）を登録する on-demand seed Job。
# command 上書きで `dist/seed-ginan-ads-cli.js` を起動。migrator DSN で system_admin context を張って固定 id 冪等 upsert。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan-ads --region asia-northeast1 --project signage-v2-prod`。
# 前提: 岐南テナントが既存（無ければ fail-loud）+ ad_media バケットに広告画像 upload 済。
module "cloud_run_job_seed_ginan_ads" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true  # bring-up: 2026-06-08 有効化（岐南 広告 seed）
  deletion_protection    = false # 使い捨て seed runner（データ非保持）
  job_name               = "kimiterrace-seed-ginan-ads"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.seed_ginan_ads_image_tag}"
  command                = ["node", "dist/seed-ginan-ads-cli.js"] # 岐南 広告 seed を起動
  database_url_secret_id = local.db_url_migrator_secret_id        # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
}

# 岐南工業テナント（学校 + 電子工学科 + 1〜3年 grades + 各1クラス）を prod に用意する on-demand seed Job。
# 他の岐南 seed（センサー/広告/TV）が「岐南テナント既存」を前提に fail-loud するため、本 Job を**先に**実行する。
# command 上書きで `dist/seed-ginan-school-cli.js` を起動。image は migrate イメージ（全 seed-cli を同梱）。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan-sch --region asia-northeast1 --project signage-v2-prod`。
# 冪等（school は SELECT→INSERT、dept/grade は ON CONFLICT、class は事前 SELECT）。再実行安全。
module "cloud_run_job_seed_ginan_school" {
  source              = "../../modules/cloud_run_job_migrate"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = true  # bring-up: 2026-06-08 有効化（岐南テナント seed・最初に execute）
  deletion_protection = false # 使い捨て seed runner（データ非保持）ゆえ recreate 容易性優先
  # 注: job_name は派生 runtime SA account_id（`<job_name>-sa`）が GCP 上限 30 文字を超えないよう短縮する
  # （"kimiterrace-seed-ginan-school" だと SA が 32 文字で plan error）。"-sch" に縮めて 26+3=29 文字に収める。
  job_name               = "kimiterrace-seed-ginan-sch"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.migrate_image_tag}"
  command                = ["node", "dist/seed-ginan-school-cli.js"] # 岐南テナント seed を起動
  database_url_secret_id = local.db_url_migrator_secret_id           # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
}

# 岐南工業 電子工学科1〜3年の TV サイネージ端末を tv_devices に登録する on-demand seed Job（#709）。
# command 上書きで `dist/seed-ginan-tv-devices-cli.js` を起動。image は migrate イメージ（全 seed-cli を同梱）。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan-tv --region asia-northeast1 --project signage-v2-prod`。
# 前提: kimiterrace-seed-ginan-sch 実行済（岐南テナント existence）。冪等（ON CONFLICT(device_id) DO NOTHING）。
# 実 device_id / target_mac は packages/db/src/seed-ginan-tv-devices.ts の GINAN_ECE_TV_DEVICES（コンパイル時
# 同梱・稼働中 LP の tv_devices 由来）を真実とする。本番の実 device に差し替える場合は当該ソースを更新して
# migrate イメージを再ビルド → migrate_image_tag を bump する（env で device 一覧は受けない設計＝改竄面を増やさない）。
module "cloud_run_job_seed_ginan_tv" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true  # bring-up: 2026-06-08 有効化（TV seed Job 作成。execute は cutover 時に実 device_id で）
  deletion_protection    = false # 使い捨て seed runner（データ非保持）ゆえ recreate 容易性優先
  job_name               = "kimiterrace-seed-ginan-tv"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.migrate_image_tag}"
  command                = ["node", "dist/seed-ginan-tv-devices-cli.js"] # 岐南 TV デバイス seed を起動
  database_url_secret_id = local.db_url_migrator_secret_id               # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
}

# F15 / F05 (#760, ADR-022 / ADR-019): 岐南 電子工学科1〜3年の各クラスにサイネージ表示用 magic link を発行し、
# 対応する tv_devices.signage_url を v2 形（https://app.school-signage.net/signage/<token>）に設定する on-demand seed Job。
# command 上書きで `dist/seed-ginan-signage-cli.js` を起動。image は migrate イメージ（全 seed-cli 同梱・#760 込み）。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan-sig --region asia-northeast1 --project signage-v2-prod`。
# 前提: kimiterrace-seed-ginan-sch（テナント）+ kimiterrace-seed-ginan-tv（device 行・class_id 紐づけ）実行済。
# 冪等: 既に v2 signage 設定済みデバイスは skip（トークン churn 防止）。token は DB に hash のみ・ログ非出力（ルール5）。
# 注: job_name は派生 SA account_id（`<job_name>-sa`）が GCP 上限 30 文字を超えないよう "-sig" に短縮
#   （"kimiterrace-seed-ginan-signage" だと 30+3=33 文字で plan error。seed-ginan-sch と同じ短縮規律）。
module "cloud_run_job_seed_ginan_signage" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true  # cutover: 2026-06-08 有効化（signage seed Job。execute は signage_url 焼込時）
  deletion_protection    = false # 使い捨て seed runner（データ非保持）ゆえ recreate 容易性優先
  job_name               = "kimiterrace-seed-ginan-sig"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.migrate_image_tag}"
  command                = ["node", "dist/seed-ginan-signage-cli.js"] # 岐南 サイネージ magic link + signage_url seed
  database_url_secret_id = local.db_url_migrator_secret_id            # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
}

# F13 (#391, ADR-020): PoC 本番(LP/Turso motion_events)の来場検知履歴を v2 events(type='presence')へ
# 取り込む on-demand backfill Job。command 上書きで `dist/backfill-presence-cli.js` を起動。
# migrator DSN で system_admin context を張り、device_mac→school_id 解決 + ON CONFLICT DO NOTHING で冪等取り込み。
# 実行: `gcloud run jobs execute kimiterrace-bf-presence --region asia-northeast1 --project signage-v2-prod`。
# 前提: sensor_devices に対象 device が登録済（kimiterrace-seed-ginan 実行済）。再実行・cutover 後の再取り込みも安全。
module "cloud_run_job_backfill_presence" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = false # TODO(bring-up ③/⑤): 必要時に true で execute
  job_name               = "kimiterrace-bf-presence"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.backfill_presence_image_tag}"
  command                = ["node", "dist/backfill-presence-cli.js"] # 来場検知履歴 backfill を起動
  database_url_secret_id = local.db_url_migrator_secret_id           # migrator DSN（system_admin context で書込）
  vpc_connector          = module.network.vpc_connector_id
}

# Identity Platform（ADR-003）。職員 email/password サインイン + claims-based（tenant 非使用）
# + web SDK apiKey。web config（apiKey/authDomain/projectId）は output で app build arg に渡す。
# MFA は本番導入ゲートで ENABLED にしうる（ADR-031）。雛形は既定 DISABLED。
module "identity_platform" {
  source     = "../../modules/identity_platform"
  project_id = var.project_id
  env        = local.env
  enabled    = true # bring-up: 2026-06-08 有効化（Identity Platform email/password）
  # create_tenant = false（既定・claims-based）/ mfa_state = DISABLED（既定。本番導入時に ENABLED を検討、ADR-031）
}

# Vertex AI API（#289 PR-2）。実 Vertex 呼び出し（F03 抽出 / F06 Q&A / F08 効果コメント）の前提。
# disable_on_destroy=false: destroy（コスト停止）時も API を無効化しない（無効化は破壊的・enable は無料）。
# 本 enable は実 Vertex 利用の前提を満たすだけで、実際の呼び出しは app の AI_ENABLED kill-switch で別途 gate
# される（既定 OFF）。staging と同じく当該 API のみを Terraform 管理下に置く（ルール8、残り API は follow-up）。
# 注: 本リソースは count を持たないため enabled スイッチに依らず常に管理対象になる。bring-up で当該 project の
#   API を Terraform 管理に編入する段で apply する（それまでは plan に現れても apply は人間ゲート、ルール8）。
resource "google_project_service" "aiplatform" {
  project                    = var.project_id
  service                    = "aiplatform.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Cloud Run web service（B5 / app デプロイ。ADR-002 / ADR-008）。apps/web を公開する。
# image = AR の web:<tag>。DATABASE_URL = app DSN secret / TV_POLL_SECRET = tv-poll secret（Secret Manager 注入）。
# VPC connector で Cloud SQL private IP に到達（Vertex / Identity Platform は既定 egress）。runtime SA に
# Vertex user + Identity Platform admin + 各 secret accessor を付与。app が自前認証ゆえ未認証 invoker（allUsers）許可。
# 2-phase apply（④）: ① secret コンテナ作成 → ② app DSN / tv-poll 値投入 → ③ full apply で service 作成。
module "cloud_run" {
  source                        = "../../modules/cloud_run"
  project_id                    = var.project_id
  region                        = var.region
  env                           = local.env
  enabled                       = true # bring-up: 2026-06-08 有効化（web 本体・TV_POLL_SECRET 配線）
  image                         = "${module.artifact_registry.image_repo_url}/web:${local.web_image_tag}"
  database_url_secret_id        = local.db_url_app_secret_id
  tv_poll_secret_id             = local.tv_poll_secret_id
  tv_poll_secret_legacy_version = local.tv_poll_secret_legacy_version # 鍵ローテ移行期のみ旧版番号を設定（無停止）。完了後 "" へ
  # F13/ADR-020: 人感センサ presence 受信 /api/sensors/switchbot/webhook の認証。cutover 設計で値は TV_POLL_SECRET と
  # 同値（prod-tv-poll-secret = 旧 LP の SWITCHBOT_WEBHOOK_SECRET）ゆえ**同一 secret を流用**する＝追加 secret/値投入/IAM 不要。
  # これが未配線の間は webhook が fail-closed(401) で presence を一切記録しない（全校 sensor が未検知のままになる真因）。
  switchbot_webhook_secret_id = local.tv_poll_secret_id
  provision_agent_secret_id   = local.provision_agent_secret_id # C方式/PR4: /api/tv/provisioning/* agent 認証
  partner_api_secret_id       = local.partner_api_secret_id     # 効果還元K1: portal↔v2 /api/partner/* 共有シークレット
  vpc_connector               = module.network.vpc_connector_id
  vertex_location             = var.region

  # 実 Vertex 呼び出し kill-switch（#289、ルール4 / ADR-030）。PII マスキング設計 + aiplatform API 有効化の
  # 検証が済むまで OFF を維持する（既定 false = AI OFF・fail-safe）。bring-up 後に検証を経て true へ flip。
  ai_enabled = true # 2026-06-12 flip: UIUX-02 AI go-live。マスキング強化(redactSuspectedNames)+test+Reviewer+aiplatform API有効を確認済。停止は false に戻して apply で即 OFF

  # #982 本番ハング修正: 会話AIが「考えています」で固まる事故の緩和。思考を無効化(=0)して構造化下書きの初回応答を
  # 最速化し、maxOutputTokens(2048) を思考が食い潰して無応答になる事象を防ぐ（env 未設定=dynamic を明示的に上書き）。
  # 実トラフィックで質を見て、必要なら小さい正の値（例 256）へ戻す（app は 0 で無効・正で上限・空で dynamic）。
  gemini_thinking_budget = "0"

  memory              = "1Gi" # Next.js SSR + AI SDK の boot/peak 余裕。scale-to-zero ゆえアイドル課金増なし。
  deletion_protection = true  # prod は誤削除防止（モジュール既定 true・明示）

  # TODO(prod hardening): min_instances は本番 bring-up 時の確定事項。既定は 0（scale-to-zero）。本番でコールド
  #   スタートを許容できない場合は min_instances を 1 以上に上げる（アイドル課金とのトレードオフ）。当てずっぽうで
  #   倒さず、実トラフィック/サイネージ・ポーリング頻度を見て確定する。max_instances もあわせて見直す。
  # min_instances = 0  # TODO(prod hardening): 本番要件で確定（既定 scale-to-zero）

  # カスタムドメイン: 本番 cutover では v1 と同一 FQDN `app.school-signage.net` を流用しフィルタ再申請ゼロ
  #   （docs/discovery/wifi-filter-method.md 制約 C01・県教委 Wi-Fi FQDN 許可リスト維持）。サイネージ表示 URL
  #   （signage_url = https://app.school-signage.net/signage/<magic-link token>）は県教委 Wi-Fi の FQDN 許可
  #   リスト上この 1 ドメインからのみ実機 TV から到達できる（.run.app は遮断）。ゆえに実機 TV cutover の前提として
  #   本マッピングを有効化する。
  # 切替手順（docs/runbooks/prod-bringup-cutover.md D/E）: apply で domain mapping 作成 → output
  #   custom_domain_dns_records（CNAME → ghs.googlehosted.com）を取得 → Vercel DNS（school-signage.net は
  #   Vercel nameserver に委譲済）で app の CNAME を school-signage-2026.web.app（v1 Firebase）→ ghs に変更 →
  #   Google マネージド TLS 証明書が自動発行。ロールバック = CNAME を Firebase に戻す。
  # 前提: apex（school-signage.net）が Search Console で所有権検証済みであること（未検証だと当該リソースのみ
  #   apply 失敗・他は無傷。検証は Vercel DNS に TXT 追加）。v1 Firebase 表示はこの CNAME 切替時に当該 FQDN から
  #   外れる（= 表示 cutover 本体）。
  custom_domain = "app.school-signage.net"

  # 広告メディア配信バケット（ADR-037）。受口 /api/ads/media が保存し /ad-media/<key> が GET する公開バケット。
  ad_media_bucket = module.ad_media.bucket_name
}

# 広告メディアアップロード受口（/api/ads/media）が公開 ad-media バケットへ保存するための最小権限（#46/ADR-037）。
# cloud_run の runtime SA に**当該バケット限定**で objectAdmin（作成+上書き+一覧）を付与する（ルール5 最小権限・
# upload_storage/report_storage の writer と同規律）。公開 read（allUsers）は ad_media モジュール側で付与済。
# 別リソースに切り出すことで module 間の循環（cloud_run⇄ad_media）を避ける（cloud_run→ad_media の単方向）。
resource "google_storage_bucket_iam_member" "web_ad_media_writer" {
  count  = module.ad_media.bucket_name != "" && module.cloud_run.runtime_service_account_email != null ? 1 : 0
  bucket = module.ad_media.bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${module.cloud_run.runtime_service_account_email}"
}

# F06 embedding バッチの Cloud Run Job + Scheduler（#416, ADR-038）。curated contents を embedding 化して
# 供給する候補経路。**ADR-040（2026-06-14）で生徒/保護者 Q&A の知識源は編集(daily_data)の直接注入へ
# 再ソース化されたため、本 Job は当面不要＝enabled=false で休眠**（ADR-038 D1/D2 は ADR-040 で supersede）。
# 配線（image/args/secret/vpc）は将来 curated contents を運用する場合の再有効化に備えて温存する（ADR-040 D3）。
#
# 二重 kill-switch（多層防御、#593 / ルール4 / ADR-030、web cloud_run と同方針）:
#   ① enabled  : Job 実体（Cloud Run Job + Scheduler + 専用 SA）の生成スイッチ。
#   ② ai_enabled: 実体生成後も AI_ENABLED!="true" の間はバッチが実 Vertex を一切叩かず no-op で抜ける。
# 停止/巻き戻しは ai_enabled=false で即 OFF（次回起動が aiDisabled で no-op、DB/Vertex 不接触）。
#
# 配線は weather/railway/tv_liveness Job と同形（同一 jobs:<tag> イメージを command/args で切替）:
#   - image                 : 既ビルド済み jobs イメージ（embed-job 同梱、dist/embedding/embed-job.js）。
#   - container_args        : embedding entry を起動（既定の src/... ではなく tsc emit 後の dist/...）。
#   - database_url_secret_id: prod-db-url-app（kimiterrace_app ロール=非 BYPASSRLS、ルール2/5）。
#   - vpc_connector         : Cloud SQL private IP への内部 egress（PRIVATE_RANGES_ONLY、外部 egress 不要）。
# Scheduler はモジュール既定で毎時起動（schedule "0 * * * *" JST）。バッチは冪等（embedding IS NULL の
# 残りだけ拾う）なので、初回起動で既存 content_versions を自動バックフィルし、以後は差分だけ処理する。
# prod は deletion_protection 既定 true。
module "cloud_run_job" {
  source                 = "../../modules/cloud_run_job"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = false # 2026-06-14 ADR-040: 知識源を daily_data 直接注入へ再ソース化したため休眠（curated contents 運用時に true へ戻して apply）。配線は温存
  ai_enabled             = true  # 2026-06-12 prod web と同じく AI go-live 済（マスキング強化+aiplatform API 有効を確認）。停止は false に戻して apply で即 OFF
  image                  = "${module.artifact_registry.image_repo_url}/jobs:${local.jobs_image_tag}"
  container_args         = ["dist/embedding/embed-job.js"] # ビルド済み embed-job（WORKDIR=/app/apps/jobs）。module 既定 src/... を上書き
  database_url_secret_id = local.db_url_app_secret_id
  vpc_connector          = module.network.vpc_connector_id
  # deletion_protection はモジュール既定 true（prod）
}

# F14 天気取得 Cloud Run Job + Scheduler + egress（#128, ADR-021）。サイネージ天気を実描画する。
# image = jobs:<tag>（jobs.Dockerfile build/push 済）。container_args で weather-job を起動。DATABASE_URL は
# 既存 app DSN secret（kimiterrace_app、書込みは run.ts が system_admin context）。vpc_connector で Cloud SQL
# private IP 到達 + 外部 egress(JMA) を VPC 経由に集約し Cloud NAT で出す（閉域原則・出口1経路）。
# external_egress_ready=network.egress_ready（NAT 実在＝true）で plan 時 fail-fast を満たす。Scheduler は
# モジュール既定で毎時起動（鮮度 6h 内に再取得、F14 §2）。prod は deletion_protection 既定 true。
module "cloud_run_job_weather" {
  source                 = "../../modules/cloud_run_job_weather"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true # 2026-06-10 有効化: jobs image 626e85c 同梱済・network(NAT)/secret 準備完了
  image                  = "${module.artifact_registry.image_repo_url}/jobs:${local.jobs_image_tag}"
  container_args         = ["dist/weather/weather-job.js"] # ビルド済み weather-job（WORKDIR=/app/apps/jobs）
  database_url_secret_id = local.db_url_app_secret_id
  vpc_connector          = module.network.vpc_connector_id
  external_egress_ready  = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-021）
  # deletion_protection はモジュール既定 true（prod）
}

# パターン2 鉄道運行情報取得 Job（名鉄スクレイピング、ADR-035）。prod は scaffold（有効化は別途人間判断）。
module "cloud_run_job_railway_status" {
  source                 = "../../modules/cloud_run_job_railway_status"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true # 2026-06-11 有効化: staging 検証済（実 名鉄ページ parse 成功）+ jobs image c40ab97 同梱（ADR-035）
  image                  = "${module.artifact_registry.image_repo_url}/jobs:${local.jobs_image_tag}"
  container_args         = ["dist/railway-status/railway-status-job.js"]
  database_url_secret_id = local.db_url_app_secret_id
  vpc_connector          = module.network.vpc_connector_id
  external_egress_ready  = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-035）
  # 鉄道 Job は状態を持たない再生成可能な取得ジョブ（データは railway_status DB 側）。weather と同様 recreate
  # 容易性を優先し deletion_protection=false（初回作成時の secret IAM 伝播レースで tainted job を replace 回収するため）。
  deletion_protection = false
}

# pattern2/3 サイネージ工学ニュース取得 Job（政府系 / JST の公開 RSS、ADR-043）。prod は scaffold（有効化は別途）。
# PR2 は **enabled=false**。有効化時: jobs image を news-job 同梱で build/push し jobs_image_tag を実 sha に
# 反映 + staging 検証（実フィード parse 成功）後に enabled=true へ flip して apply する（image が
# dist/news/news-job.js を含む前に Job を作らない）。新規 secret は不要（DATABASE_URL は既存 app DSN 流用・RSS キーレス）。
module "cloud_run_job_news" {
  source                 = "../../modules/cloud_run_job_news"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true # 2026-06-18 有効化: jobs image 98cc9d8 同梱・staging 検証済（feeds:2 rowsUpserted:25）・ADR-043
  image                  = "${module.artifact_registry.image_repo_url}/jobs:${local.jobs_image_tag}"
  container_args         = ["dist/news/news-job.js"]
  database_url_secret_id = local.db_url_app_secret_id
  vpc_connector          = module.network.vpc_connector_id
  external_egress_ready  = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-043）
  # ニュース Job も状態を持たない再生成可能な取得ジョブ（データは news_items DB 側）。weather / railway と同様
  # recreate 容易性を優先し deletion_protection=false（初回作成時の secret IAM 伝播レースで replace 回収するため）。
  deletion_protection = false
}

# F16 TV 死活監視 Cloud Run Job + Scheduler（毎分・24/7）+ Slack 配信 + egress（#94, ADR-023 / PR7 §9）。
# image = jobs:<tag>（weather と同じ jobs イメージを共有・command/args だけ差し替え）。container_args で
# tv-liveness-job を起動。DATABASE_URL は既存 app DSN secret（kimiterrace_app、down/recover 反映は run.ts が
# system_admin context）。vpc_connector で Cloud SQL private IP 到達 + 外部 egress(Slack) を VPC 経由に集約し
# Cloud NAT で出す（閉域原則・出口1経路）。SLACK_WEBHOOK_URL は prod-slack-webhook-url secret（PR7 §9・人間投入）。
#
# ★ prod は **enabled = false**（雛形）。jobs イメージ未ビルド（jobs_image_tag = "REPLACE_AT_BRINGUP"）+
#   prod-slack-webhook-url 値未投入のため、enabled=true で placeholder image を本番に出さない（規律）。
# TODO(bring-up): jobs イメージを build/push し jobs_image_tag を実 sha に置換 + prod-provision-agent-secret /
#   prod-slack-webhook-url の値を投入 → enabled = true に倒し schedule "* * * * *"（毎分）で apply する。
module "cloud_run_job_tv_liveness" {
  source                      = "../../modules/cloud_run_job_tv_liveness"
  project_id                  = var.project_id
  region                      = var.region
  env                         = local.env
  enabled                     = true        # 2026-06-09 点灯: jobs image build 済 + prod-slack-webhook-url 投入済（毎分・down-only 🔴）
  schedule                    = "* * * * *" # 毎分（24/7）。enabled=true 化時に効く（ADR-023 / F16 §2）
  image                       = "${module.artifact_registry.image_repo_url}/jobs:${local.jobs_image_tag}"
  container_args              = ["dist/tv-liveness/tv-liveness-job.js"] # ビルド済み tv-liveness-job
  database_url_secret_id      = local.db_url_app_secret_id
  slack_webhook_url_secret_id = local.slack_webhook_url_secret_id # PR7 §9: device_down/recovered 配信（値は人間投入）
  vpc_connector               = module.network.vpc_connector_id
  external_egress_ready       = module.network.egress_ready # network の Cloud NAT 実在 signal（Slack 外部 egress、ADR-021）
  # deletion_protection はモジュール既定 true（prod）
}

# Cloud Logging 閲覧の最小権限 IAM（ADR-029 / #439）。
# 公開ルート（magic-link / webhook）の秘匿値が載る request log の閲覧を運用者へ限定する。
# enabled 化時に var.log_viewer_members（運用者グループ + breakglass）を設定すること。
module "logging_iam" {
  source             = "../../modules/logging_iam"
  project_id         = var.project_id
  env                = local.env
  enabled            = true # bring-up: 2026-06-08 有効化（運用ログ閲覧 最小権限）
  log_viewer_members = ["user:20051215kaito@gmail.com"]
}

# 月次レポート PDF の Cloud Storage バケット（F09 / #430）。90 日後コールド移送。prod は force_destroy 既定 false。
# writer_service_account に reports Job runtime SA を渡し、当該バケット限定で objectAdmin を付与（ルール5 最小権限）。
# 雛形段階は両モジュール enabled=false ＝ SA 未生成（output null）→ "" にフォールバックして付与なし。
module "report_storage" {
  source                 = "../../modules/report_storage"
  project_id             = var.project_id
  env                    = local.env
  enabled                = true # bring-up: 2026-06-08 有効化（月次レポート PDF バケット）
  writer_service_account = module.cloud_run_job_reports.runtime_service_account_email != null ? module.cloud_run_job_reports.runtime_service_account_email : ""
}

# F09 月次レポート生成 Cloud Run Job + Scheduler（#430, #45）。雛形段階は enabled = false。
# enabled 化時: image / vpc_connector(network) / database_url_secret_id(secret_manager) /
#   report_bucket(report_storage.bucket_name) を設定。外部 egress は不要（Cloud SQL + GCS のみ、embedding と同設計）。
# Scheduler は月初 04:00 JST（前月分を生成）。prod は deletion_protection 既定 true。
# runtime SA の email は report_storage.writer_service_account に配線済。
module "cloud_run_job_reports" {
  source        = "../../modules/cloud_run_job_reports"
  project_id    = var.project_id
  region        = var.region
  env           = local.env
  enabled       = false # TODO(bring-up ③)
  report_bucket = module.report_storage.bucket_name
}

# 教員アップロード素材の Cloud Storage バケット（F01 / #509 / #37, ADR-024）。90 日後コールド移送。
# prod は force_destroy 既定 false。enabled 化時に upload 受口 runtime SA を writer_service_account に設定し、
# Cloud Run の env に出力 bucket_name を渡す。生徒 PII 素材のため CMEK 推奨（kms_key_name に KMS key を設定、
# 鍵 + IAM は KMS module follow-up）。取得監査が要れば log_bucket を設定（アップロード導線は follow-up）。
module "upload_storage" {
  source     = "../../modules/upload_storage"
  project_id = var.project_id
  env        = local.env
  enabled    = true # bring-up: 2026-06-08 有効化（教員アップロード素材バケット）
}

module "workload_identity_federation" {
  source = "../../modules/workload_identity_federation"

  project_id = var.project_id
  repository = var.repository
  env_name   = local.env
}

output "image_repo_url" {
  description = "コンテナイメージ push 先 prefix（docker tag/push に使う）。例: <prefix>/migrate:<sha>"
  value       = module.artifact_registry.image_repo_url
}

# app build 用 Firebase web config（NEXT_PUBLIC_*・公開値）。`terraform output -raw firebase_api_key` 等で取得し
# app image build の --build-arg に渡す（NEXT_PUBLIC は build 時 inline）。
output "firebase_api_key" {
  description = "NEXT_PUBLIC_FIREBASE_API_KEY（公開値だが provider sensitive 扱い）"
  value       = module.identity_platform.web_api_key
  sensitive   = true
}

output "firebase_auth_domain" {
  description = "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"
  value       = module.identity_platform.auth_domain
}

output "firebase_project_id" {
  description = "NEXT_PUBLIC_FIREBASE_PROJECT_ID"
  value       = module.identity_platform.project_id
}

output "wif_provider_name" {
  description = "Pass to GitHub Actions vars as WIF_PROVIDER."
  value       = module.workload_identity_federation.provider_name
}

output "wif_deploy_sa_email" {
  description = "Pass to GitHub Actions vars as WIF_SA_DEPLOY."
  value       = module.workload_identity_federation.deploy_sa_email
}

output "wif_plan_sa_email" {
  description = "Pass to GitHub Actions vars as WIF_SA_PLAN."
  value       = module.workload_identity_federation.plan_sa_email
}

# Cloud Run web service の URL（B5）。smoke: `<uri>/login` を curl（200・HTML）。
output "cloud_run_service_uri" {
  description = "Cloud Run web service の URL（未生成なら null）。smoke 用。"
  value       = module.cloud_run.service_uri
}

output "custom_domain" {
  description = "マッピング済みカスタムドメイン（未設定なら null）。"
  value       = module.cloud_run.custom_domain
}

output "custom_domain_dns_records" {
  description = "カスタムドメインが要求する DNS レコード。apply 後 DNS に登録する（未設定なら空）。"
  value       = module.cloud_run.custom_domain_dns_records
}
