# staging 環境ルート
# prod と同構成、tier だけ縮小。雛形段階は実体生成なし。

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
    prefix = "envs/staging"
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
  default     = "signage-v2-staging"
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
  env = "staging"
  # アプリ DB ユーザー（app）のパスワードを保持する Secret Manager secret ID（ルール5）。
  # 値（パスワード）は人間が `gcloud secrets versions add staging-db-app-password --data-file=-` で投入する。
  # 同じ ID を secret_manager（コンテナ作成）と cloud_sql（data source で参照）の両方に渡す。
  db_app_password_secret_id = "staging-db-app-password"

  # migration（M3）用の secret ID（ルール5・値は人間投入）。
  # - migrator のパスワード（raw）: cloud_sql の google_sql_user.migrator が data source で読む。
  # - migrator の DSN（full）: migration Cloud Run Job が DATABASE_URL env として Secret Manager から注入。
  # 人間は 1 コマンドで同一 pw から両方を投入する（後述 runbook / 引き継ぎ参照）。
  db_migrator_password_secret_id = "staging-db-migrator-password"
  db_url_migrator_secret_id      = "staging-db-url-migrator"

  # migration Job が使うイメージタグ（再ビルド時はここを更新）。
  # 91fd593: #675 で ads.advertiser_id を追加（運営側広告 CRM）。migrate runner は _schema_migrations で
  #          適用済みを追跡し未適用分のみ冪等適用するため、本 image で Job を実行すると advertiser_id（+ 途中の
  #          未適用があれば）のみ流れる。main HEAD(91fd593) から Cloud Build 済・AR push 済。
  migrate_image_tag = "91fd593"

  # #289 ④: seed Job が使うイメージタグ。migrate イメージに seed-staging-cli を含めて再ビルドした版
  # （同一 Dockerfile・command 上書きで `dist/seed-staging-cli.js` を起動）。app 層 E2E 用フィクスチャ投入。
  # seed-e2e2: seed-cli を生 SQL 化（barrel import 由来の @kimiterrace/ai 推移依存を除去）した再ビルド版。
  # seed-e2e3: FORCE RLS 下で system_admin context を張って seed する版（migrator は非 BYPASSRLS）。
  # seed-signage1: F12 サイネージ実機確認用に class + クラス用 magic-link + 当日 daily_data を追加 seed する版。
  seed_image_tag = "seed-signage1"

  # F13 (#391, ADR-020): 岐南工業 電子工学科1〜3年の設置済 SwitchBot を sensor_devices に登録する seed Job の
  # イメージタグ。migrate イメージに seed-ginan-sensors-cli を含む版（同一 Dockerfile・command 上書きで
  # `dist/seed-ginan-sensors-cli.js` を起動）。665b6b7 = 学校名を実レコード「岐阜県立岐南工業高等学校」に
  # 修正した版（5765ea2 は旧名「岐阜県立岐南工業高校」で fail-loud したため差し替え）。
  seed_ginan_image_tag = "665b6b7"

  # 岐南 電子工学科 PoC の実契約 6 社サイネージ広告（advertisers + 学校スコープ ads）を登録する seed Job の
  # イメージタグ。migrate イメージに seed-ginan-ads-cli を含む版（同一 Dockerfile・command 上書きで
  # `dist/seed-ginan-ads-cli.js` を起動）。seed-ginan-ads1 = feat/ginan-ads から build した版。
  seed_ginan_ads_image_tag = "seed-ginan-ads1"

  # F14 (#128, ADR-021): apps/jobs（天気取得 Job 等）が使うイメージタグ。jobs.Dockerfile で build/push 済。
  # bd1c9fb: 初版だが dist が部分 emit（weather 欠落）で weather-job が MODULE_NOT_FOUND（不採用）。
  # 08e8ba5: Dockerfile に fail-fast 検証 + tsconfig incremental:false。weather-job 同梱を build 時に保証。
  jobs_image_tag = "08e8ba5"

  # app の DATABASE_URL（DSN）を保持する Secret Manager secret ID（ルール5・値は人間投入）。
  # Cloud Run web service が DATABASE_URL env として Secret Manager から注入する。
  db_url_app_secret_id = "staging-db-url-app"

  # Cloud Run web service（B5）が使う app イメージタグ（build/push 済・実 Firebase config 込み）。
  # 5300a20: pdfjs-dist standard_fonts を standalone に明示同梱（Issue #311 起動時 assert 修正）。
  # a6463f5: 全ルートにセキュリティレスポンスヘッダを付与（live DAST 検証で欠落検出）。
  # 96769b2: #289 ① kill-switch（AI_ENABLED 既定 OFF・全 Vertex 入口を gate）+ ③ F03 PII soft-gate 同梱。
  #          実 Vertex 有効化の前段として、この gated image を **API 有効化より前に** deploy（#592/#595）。
  # 6f504d3: #289 ④ retired モデルピン修正（gemini-1.5-pro-002→gemini-2.5-flash、#598）。実 Vertex を
  #          現行モデルで稼働させるための再 deploy（AI_ENABLED=true 維持）。実 Vertex 結合 test で裏取り済。
  # 37a19de: #605 Permissions-Policy を microphone=(self) に修正（F02 教員音声入力のブロック回帰を解消）。
  #          ヘッダは next build 時に焼かれるため、修正反映には再 build/deploy が必須（本タグ bump）。
  # 548a212: 実機UIテストで見つかった一連の改善をまとめて反映 — #611 MFA詰まり / #612 ブランド適用・
  #          ログイン刷新・レスポンシブ・ログイン後遷移修正・open-redirect 防止 / #615 送信後UX導線 /
  #          #614 監視系の学校側撤去・エディタ403行き止まり修正。UI/認可変更ゆえ再 build/deploy で反映。
  # 6e62f09: 多ロール(school_admin/system_admin)UI巡回の改善一式 — #618 グラデ→ソリッド / #620 日本語
  #          エラー/404境界 / #621 ログアウト可視化・広告主nav配線・教員i18n・体裁 / #622 モバイル浮遊
  #          メニュー・no-gradient原則。UI/CSS変更ゆえ再 build/deploy で反映。
  # f6f4ae6: #626 サイネージ盤面を v1 マットトーンデザインに移植（CSS Module 化）。UI 変更ゆえ再 deploy。
  #          ※ main HEAD ではなく #626 の squash commit を指す。直後の #627（@kimiterrace/ui を
  #          transpilePackages 追加）が production Docker build（pnpm --filter web... build + Turbopack）を
  #          @kimiterrace/ai の `./model/*.js` 96 件 Module-not-found で壊すため、修正までデプロイから除外。
  # 1bc1666: 上記 #627 の build 破壊は stale dist 起因のローカル偽陽性で、クリーン Cloud Build では再現せず
  #          （web:1bc1666 ビルド成功・AR push 済）。さらに no-traffic canary で /signage（@kimiterrace/db→ai
  #          推移 import を runtime で叩く公開経路）と /api/health がいずれも 200 で runtime も健全と確認。
  #          よって #627 / #628(F15 TV登録UI) / #629(学校管理者・教員 発行UI) を含む 1bc1666 を deploy する。
  # bbb68be: #634 Toast 通知基盤 + #636 ブランドオレンジ明色化(#ea580c)+ルート / のロール別振り分け +
  #          #638 サイドナビ active 判定を最長一致化(親子二重点灯バグ修正)。UI 変更ゆえ再 deploy。
  #          ※ main HEAD は #637(ConfirmDialog 段3) まで進むが、本 deploy は bbb68be を指す（#637 は次回）。
  # b1ed208: 段3 confirm 統一の残りを反映 — #637 教職員管理 / #640 広告主・契約 / #641 MFA の
  #          window.confirm→共通 ConfirmDialog + 成功 Toast。これで apps/web の window.confirm は全廃。
  #          UI 変更ゆえ再 build/deploy で反映（web:b1ed208 を Cloud Build 済・AR push 済、main HEAD）。
  # 1216a84: #642 学校管理ハブの学科/学年/クラス 編集・削除 + 学年の全学科一括追加。b1ed208 を内包＋#642。
  #          web:1216a84 を Cloud Build 済・AR push 済。#644(b1ed208) merge 後にこれを上書き deploy する。
  # 7495bc0: #643 公開サイネージ盤面を v1 レイアウトに作り直し（予定=今後3平日3列5行 / 連絡 / 提出物表 /
  #          広告70:30 / 天気は小さく残置・静粛時間除外）。1216a84(#642 含む) を内包＋#643。main HEAD。
  #          web:7495bc0 を Cloud Build 済・AR push 済。なお #627 は build を恒常ブロックしない（#632 訂正済）。
  # ce55060: #648 学校管理の階層をツリー（枝分かれ）UI化 + 教員セッション 5→14 日。7495bc0 を内包＋#648。
  #          web:ce55060 を Cloud Build 済・AR push 済。
  # b9d37f0: 段3 FormField 採用を反映 — #650 広告主 新規登録 / #652 教員発行 のフォームに項目別インライン
  #          検証（検証規則を core の単一ソースに統合）。ce55060(#646 学校フォーム/#648 含む) を内包＋#650/#652。
  #          UI 変更ゆえ再 build/deploy で反映（web:b9d37f0 を Cloud Build 済・AR push 済、main HEAD）。
  # 575e39c: #654 階層UX改善（処理中表示 / クラス追加=名前のみ / 学年を1まとまりに）を反映。b9d37f0 を
  #          内包＋#654（= 現 main HEAD・全機能込み）。web:575e39c を Cloud Build 済・AR push 済。
  # f150e03: #660 エディタ対象選択を階層ツリー化＋各画面に「戻る」追加（段A-1）。575e39c を内包＋#660。
  #          web:f150e03 を Cloud Build 済・AR push 済。
  # 5752b31: #664 サイネージ(pattern1) 天気をヘッダー日付の隣へ移動・情報量を絞る + 「予定」見出し省略。
  #          f150e03 を内包＋#664。web:5752b31 を Cloud Build 済・AR push 済。
  # afaaae3: #666 MFA を UI（サイドナビ）から撤去（機能・コードは残置）。5752b31 を内包＋#666。
  #          web:afaaae3 を Cloud Build 済・AR push 済。
  # eb0aa96: #667 サイネージ(pattern1) モバイル応答化 — 縦並び順序を タブ→広告→予定→連絡→提出物→フッター
  #          に固定（広告を表面=上部に）＋盤面をスクロール可能化（外殻 fixed shell の clip 回避＝mobile
  #          .signageRoot を overflow-y:auto のスクロールコンテナ化）＋予定 3日×3行＋広告領域全体タップで
  #          管理設定リンクへ遷移（http(s) 限定サニタイズ）。afaaae3 を内包＋#667（= 現 main HEAD・全機能込み）。
  #          web:eb0aa96 を Cloud Build 済・AR push 済。
  # 91fd593: 運営側広告 CRM を反映 — #675 ads.advertiser_id / #676 運営広告 actions・query / #677 広告主配下
  #          の広告管理 UI（入稿/一覧/削除、scope=school）。eb0aa96 を内包＋#675/#676/#677（main HEAD は
  #          c64d328=#678 seed 修正だが web/schema 非影響ゆえ 91fd593 で同等）。**migrate_image_tag も同 sha に
  #          bump 済 → 本 deploy 前に migrate Job 実行で advertiser_id を staging DB に適用すること**。
  #          web:91fd593 を Cloud Build 済・AR push 済。
  web_image_tag = "91fd593"
}

module "network" {
  source            = "../../modules/network"
  project_id        = var.project_id
  region            = var.region
  env               = local.env
  enabled           = true
  psa_range_address = "10.60.0.0" # connector_cidr 10.8.0.0/28 と非重複（PR #493 enable-time 対応）
}

# Cloud SQL for PostgreSQL 16 + pgvector（ADR-001 / ADR-007）。
# staging は private IP only + SSL 強制 + pgvector + 自動バックアップ/PITR + ZONAL（HA は prod のみ）。
# private IP は network の PSA peering 上に割り当てられるため、network_id と private_services_ready を配線し
# peering -> instance の順序を強制する（private_services_ready が false なら plan 時 fail-fast）。
# DB ユーザー（google_sql_user.app）は Secret Manager 配備後に別ステップで有効化（現状 module 側 count=0）。
module "cloud_sql" {
  source                 = "../../modules/cloud_sql"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  tier                   = "db-custom-1-3840"
  availability_type      = "ZONAL"                               # staging は HA 不要（prod のみ REGIONAL）
  deletion_protection    = false                                 # staging も recreate 容易性優先（Issue #70）
  vpc_network_id         = module.network.network_id             # private IP を割り当てる VPC
  private_services_ready = module.network.private_services_ready # PSA peering 実在 signal（順序強制）

  # アプリ DB ユーザー（app）のパスワード secret（secret_manager が作成・人間が値を投入）。
  # 2-phase apply: ① -target=module.secret_manager で secret コンテナ作成 → ② 人間が値投入 → ③ full apply で user 作成。
  # secret 値未投入の状態で full apply すると data source が読めず失敗するため、必ず ②→③ の順で進める。
  app_db_password_secret_id = local.db_app_password_secret_id

  # migrator DB ユーザー（migration 実行・テーブル所有）のパスワード secret（同じ 2-phase apply）。
  migrator_db_password_secret_id = local.db_migrator_password_secret_id
}

# Secret Manager（ルール5）。staging はまずアプリ DB ユーザーのパスワード secret コンテナを作る。
# Terraform はコンテナのみ作成し、値（パスワード）は人間が投入する:
#   gcloud secrets versions add staging-db-app-password --data-file=- --project=signage-v2-staging
# accessor SA は Cloud Run runtime SA 生成後（cloud_run enabled 化時）に配線する。現状の DB user 作成・
# migration は人間 ADC / Cloud SQL proxy 経由で読むため accessor 不要。DATABASE_URL 等の secret は導入時に追加。
module "secret_manager" {
  source     = "../../modules/secret_manager"
  project_id = var.project_id
  env        = local.env
  enabled    = true
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
  }
}

# Artifact Registry（Docker）— migration Cloud Run Job + Cloud Run app(B5) の image 置き場（ルール8 / ADR-002）。
# イメージは `<region>-docker.pkg.dev/<project>/kimiterrace/<image>:<tag>` で push する（output image_repo_url 参照）。
module "artifact_registry" {
  source        = "../../modules/artifact_registry"
  project_id    = var.project_id
  region        = var.region
  env           = local.env
  enabled       = true
  repository_id = "kimiterrace"
}

# DB migration Cloud Run Job（M3, #243）。private-IP-only な Cloud SQL へ migration を適用する on-demand Job。
# 実行: `gcloud run jobs execute kimiterrace-migrate --region asia-northeast1 --project signage-v2-staging`。
# image = AR の migrate:<tag>（M2 build/push 済）。DATABASE_URL = migrator DSN secret。VPC connector で private IP 到達。
# migrator user / DSN secret は人間の値投入（ルール5）が前提ゆえ、secret 未投入のうちは Job 実行が失敗する
# （リソース作成は通るが run で DATABASE_URL secret version 不在になる）→ 値投入後に execute する。
module "cloud_run_job_migrate" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.migrate_image_tag}"
  database_url_secret_id = local.db_url_migrator_secret_id
  vpc_connector          = module.network.vpc_connector_id
  grant_app_role_member  = "app" # migration 後 GRANT kimiterrace_app TO app（app login が SET ROLE できるように）
  deletion_protection    = false # staging は recreate 容易性優先（Issue #70）
}

# #289 ④: app 層 E2E 用 staging テストフィクスチャ seed Job（on-demand）。
# migrate と同じモジュール/イメージを **command 上書き** で再利用し、`dist/seed-staging-cli.js` を起動する。
# migrator DSN（BYPASSRLS）で 1 校 + 1 教員 + 1 teacher_input を投入（冪等）。実行は
# `gcloud run jobs execute kimiterrace-seed --region asia-northeast1 --project signage-v2-staging`。
# IdP アカウント作成 + login + F03/F06 実呼び出しはローカルから行う（本 Job は DB seed のみ）。
module "cloud_run_job_seed" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  job_name               = "kimiterrace-seed"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.seed_image_tag}"
  command                = ["node", "dist/seed-staging-cli.js"] # migrate-cli でなく seed-cli を起動
  database_url_secret_id = local.db_url_migrator_secret_id      # migrator DSN（BYPASSRLS で cross-tenant seed）
  vpc_connector          = module.network.vpc_connector_id
  deletion_protection    = false
}

# F13 (#391, ADR-020): 岐南工業 電子工学科1〜3年 設置済 SwitchBot を sensor_devices に登録する on-demand seed Job。
# cloud_run_job_seed と同モジュール/イメージを **command 上書き** で再利用し `dist/seed-ginan-sensors-cli.js` を
# 起動する。migrator DSN で system_admin context を張って冪等 INSERT（実 MAC は LP 本番 tv_devices 由来）。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan --region asia-northeast1 --project signage-v2-staging`。
# 前提: schools に「岐阜県立岐南工業高等学校」+ departments=電子工学科 / 1〜3年 grades・classes が既存（無ければ
# seed が fail-loud で中断し DB を変更しない）。再実行は ON CONFLICT(device_mac) DO NOTHING で安全。
module "cloud_run_job_seed_ginan" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  job_name               = "kimiterrace-seed-ginan"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.seed_ginan_image_tag}"
  command                = ["node", "dist/seed-ginan-sensors-cli.js"] # 岐南センサー seed を起動
  database_url_secret_id = local.db_url_migrator_secret_id            # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
  deletion_protection    = false
}

# サイネージ広告クリエイティブの公開配信バケット（#46/#48-F）。サイネージ端末が ads.media_url を直接 GET する。
# 広告は公開掲示物（PII なし）ゆえ公開 read。教員アップロード（upload_storage, PII あり）とは逆の公開ポリシー。
# 画像実体（オブジェクト）は content ゆえ Terraform 管理外（gcloud storage cp で upload）。
module "ad_media" {
  source        = "../../modules/ad_media"
  project_id    = var.project_id
  location      = var.region
  env           = local.env
  enabled       = true
  force_destroy = true # staging は recreate 容易性優先（#70 同規律）
}

# 岐南 電子工学科 PoC の実契約 6 社サイネージ広告（advertisers + 学校スコープ ads）を登録する on-demand seed Job。
# cloud_run_job_seed_ginan と同モジュール/イメージを **command 上書き** で再利用し `dist/seed-ginan-ads-cli.js` を
# 起動する。migrator DSN で system_admin context を張って固定 id 冪等 upsert。
# 実行: `gcloud run jobs execute kimiterrace-seed-ginan-ads --region asia-northeast1 --project signage-v2-staging`。
# 前提: schools に「岐阜県立岐南工業高等学校」が既存（無ければ fail-loud）+ ad_media バケットに 6 画像 upload 済。
module "cloud_run_job_seed_ginan_ads" {
  source                 = "../../modules/cloud_run_job_migrate"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  job_name               = "kimiterrace-seed-ginan-ads"
  image                  = "${module.artifact_registry.image_repo_url}/migrate:${local.seed_ginan_ads_image_tag}"
  command                = ["node", "dist/seed-ginan-ads-cli.js"] # 岐南 広告 seed を起動
  database_url_secret_id = local.db_url_migrator_secret_id        # migrator DSN（system_admin context で seed）
  vpc_connector          = module.network.vpc_connector_id
  deletion_protection    = false
}

# Identity Platform（ADR-003）。職員 email/password サインイン + claims-based（tenant 非使用）
# + web SDK apiKey。web config（apiKey/authDomain/projectId）は output で app build arg に渡す。
module "identity_platform" {
  source     = "../../modules/identity_platform"
  project_id = var.project_id
  env        = local.env
  enabled    = true
  # create_tenant = false（既定・claims-based）/ mfa_state = DISABLED（既定・staging 初期）
}

# Cloud Run web service（B5 / app デプロイ。ADR-002 / ADR-008）。apps/web を公開する。
# image = AR の web:<tag>（B5 build/push 済・実 Firebase config 込み）。DATABASE_URL = app DSN secret。
# VPC connector で Cloud SQL private IP に到達（Vertex / Identity Platform は既定 egress）。runtime SA に
# Vertex user + Identity Platform admin + DSN secret accessor を付与。app が自前認証ゆえ未認証 invoker
# （allUsers）を許可。2-phase apply:
#   ① apply -target=module.secret_manager で staging-db-url-app コンテナ作成
#   ② 人間が app DSN 投入（postgresql://app:<pw>@10.60.0.3:5432/kimiterrace?sslmode=require）
#   ③ full apply で service 作成。
# secret 値未投入で apply すると runtime で DATABASE_URL secret version 不在になるため、②→③ の順で進める。
# Vertex AI API（#289 PR-2）。実 Vertex 呼び出し（F03 抽出 / F06 Q&A / F08 効果コメント）の前提。
# 既存の bootstrap 済 API 群は gcloud で Terraform 外管理のため、本リソースは **当該 API のみ** を Terraform
# 管理下に置く（残り API の import 整合性は follow-up・ルール8）。disable_on_destroy=false: destroy（コスト停止）
# 時も API を無効化しない（無効化は破壊的・enable は無料）。本 enable は実 Vertex 利用の前提を満たすだけで、
# 実際の呼び出しは app の AI_ENABLED kill-switch（PR #592）で別途 gate される（既定 OFF）。
resource "google_project_service" "aiplatform" {
  project                    = var.project_id
  service                    = "aiplatform.googleapis.com"
  disable_on_destroy         = false
  disable_dependent_services = false
}

module "cloud_run" {
  source                 = "../../modules/cloud_run"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  image                  = "${module.artifact_registry.image_repo_url}/web:${local.web_image_tag}"
  database_url_secret_id = local.db_url_app_secret_id
  vpc_connector          = module.network.vpc_connector_id
  vertex_location        = var.region
  # #289 ④: 実 Vertex 有効化。前段の安全条件を満たして on にする — kill-switch (#592) + F03 soft-gate (#595)
  # を含む gated image (web:96769b2) deploy 済 + aiplatform.googleapis.com 有効化済。ユーザー go (2026-06-05)
  # で flip。停止/巻き戻しは ai_enabled = false に戻して apply で即 OFF（kill-switch が全 Vertex 入口を再封鎖）。
  ai_enabled          = true
  memory              = "1Gi" # Next.js SSR + AI SDK の boot/peak 余裕。scale-to-zero ゆえアイドル課金増なし。
  deletion_protection = false # staging は recreate 容易性優先（Issue #70）
  # カスタムドメイン（#601 で land した gated 機構を flip で活性化）。apex school-signage.net は
  # 2026-06-05 に Search Console で所有権検証済（確認方法=DNS TXT・apex に google-site-verification）。
  # apply で google_cloud_run_domain_mapping が作成され、output custom_domain_dns_records の CNAME
  # （staging → ghs.googlehosted.com）を Vercel DNS に登録 → マネージド TLS 自動発行。
  # v1 の app.school-signage.net は無傷（本番 cutover 時に同一 FQDN を流用しフィルタ再申請ゼロ）。
  # 校内 Wi-Fi 許可リスト外（校外・合成データでの検証用途）。
  custom_domain = "staging.school-signage.net"
}

# F06 embedding バッチの Cloud Run Job + Scheduler（#416）。雛形段階は enabled = false。
# AI kill-switch は二重ゲート: ① enabled=false で Job 実体未生成、② ai_enabled=false で（Job 活性化後も）
# バッチが実 Vertex を呼ばない（#593、ルール4 / ADR-030、web cloud_run と同方針）。enabled=true へ flip する
# 際は image / vpc_connector(network) / database_url_secret_id(secret_manager) を設定し、PII マスキング設計 +
# aiplatform API 有効化の検証が済んでから ai_enabled=true に上げる（停止/巻き戻しは ai_enabled=false で即 OFF）。
module "cloud_run_job" {
  source              = "../../modules/cloud_run_job"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false
  ai_enabled          = false # 実 Vertex kill-switch（既定 OFF）。検証完了後に true へ flip（#593）。
  deletion_protection = false # staging は recreate 容易性優先（Issue #70）
}

# F14 天気取得 Cloud Run Job + Scheduler + egress（#128, ADR-021）。staging で有効化（サイネージ天気を実描画）。
# image = jobs:<tag>（jobs.Dockerfile build/push 済）。container_args で weather-job を起動。DATABASE_URL は
# 既存 app DSN secret（kimiterrace_app、書込みは run.ts が system_admin context）。vpc_connector で Cloud SQL
# private IP 到達 + 外部 egress(JMA) を VPC 経由に集約し Cloud NAT で出す（閉域原則・出口1経路）。
# external_egress_ready=network.egress_ready（NAT 実在＝true）で plan 時 fail-fast を満たす。Scheduler は
# モジュール既定で毎時起動（鮮度 6h 内に再取得、F14 §2）。Sentry は未設定（sentry_dsn_secret_id 空）。
module "cloud_run_job_weather" {
  source                 = "../../modules/cloud_run_job_weather"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  deletion_protection    = false # staging は recreate 容易性優先（Issue #70）
  image                  = "${module.artifact_registry.image_repo_url}/jobs:${local.jobs_image_tag}"
  container_args         = ["dist/weather/weather-job.js"] # ビルド済み weather-job（WORKDIR=/app/apps/jobs）
  database_url_secret_id = local.db_url_app_secret_id
  vpc_connector          = module.network.vpc_connector_id
  external_egress_ready  = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-021）
}

# Cloud Logging 閲覧の最小権限 IAM（ADR-029 / #439）。
# 公開ルート（magic-link / webhook）の秘匿値が載る request log の閲覧を運用者へ限定する。
# enabled 化時に var.log_viewer_members（運用者グループ + breakglass）を設定すること。
module "logging_iam" {
  source     = "../../modules/logging_iam"
  project_id = var.project_id
  env        = local.env
  enabled    = false # TODO(Phase 開発): true + log_viewer_members を設定
}

# 月次レポート PDF の Cloud Storage バケット（F09 / #430）。90 日後コールド移送。
# staging は recreate 容易性優先で force_destroy=true（Issue #70 同規律）。
# writer_service_account に reports Job runtime SA を渡し、当該バケット限定で objectAdmin を付与（ルール5 最小権限）。
# 雛形段階は両モジュール enabled=false ＝ SA 未生成（output null）→ "" にフォールバックして付与なし。
module "report_storage" {
  source                 = "../../modules/report_storage"
  project_id             = var.project_id
  env                    = local.env
  enabled                = false # TODO(Phase 開発)
  force_destroy          = true
  writer_service_account = module.cloud_run_job_reports.runtime_service_account_email != null ? module.cloud_run_job_reports.runtime_service_account_email : ""
}

# F09 月次レポート生成 Cloud Run Job + Scheduler（#430, #45）。雛形段階は enabled = false。
# enabled 化時: image / vpc_connector(network) / database_url_secret_id(secret_manager) /
#   report_bucket(report_storage.bucket_name) を設定。外部 egress は不要（Cloud SQL + GCS のみ、embedding と同設計）。
# Scheduler は月初 04:00 JST（前月分を生成）。runtime SA の email は report_storage.writer_service_account に配線済。
module "cloud_run_job_reports" {
  source              = "../../modules/cloud_run_job_reports"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false
  deletion_protection = false # staging は recreate 容易性優先（Issue #70）
  report_bucket       = module.report_storage.bucket_name
}

# 教員アップロード素材の Cloud Storage バケット（F01 / #509 / #37, ADR-024）。90 日後コールド移送。
# staging は recreate 容易性優先で force_destroy=true（Issue #70 同規律）。
# enabled 化時に upload 受口 runtime SA を writer_service_account に設定し、Cloud Run の env に
# 出力 bucket_name を渡す。生徒 PII 素材のため CMEK 推奨（kms_key_name に KMS key を設定）。
module "upload_storage" {
  source        = "../../modules/upload_storage"
  project_id    = var.project_id
  env           = local.env
  enabled       = false # TODO(Phase 開発)
  force_destroy = true
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
  description = "カスタムドメインが要求する DNS レコード。apply 後 Vercel DNS に登録する（未設定なら空）。"
  value       = module.cloud_run.custom_domain_dns_records
}
