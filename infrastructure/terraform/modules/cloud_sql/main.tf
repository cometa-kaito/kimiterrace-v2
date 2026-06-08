# Cloud SQL for PostgreSQL 16 + pgvector（ADR-001 / ADR-007）
# セキュリティ要件（公立校 生徒データ・10 年保管）:
#   - private IP only（public IP 無効）。VPC 経由でのみ到達可能。
#   - 転送時 SSL/TLS を強制（ssl_mode = ENCRYPTED_ONLY）。
#   - 自動バックアップ + PITR（point-in-time recovery）で漏洩時・誤操作時の復旧を担保。
#   - pgvector 拡張を有効化（ADR-007 RAG）。
#   - HA(REGIONAL) は prod のみ。staging/dev は ZONAL（availability_type 既定 ZONAL）。
# enabled = false（雛形）では count = 0 で実体を作らない（plan 空・validate 緑・後方互換）。

resource "google_sql_database_instance" "main" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = var.instance_name
  database_version = "POSTGRES_16"

  settings {
    tier = var.tier

    # db-custom-* / db-f1-micro 等の tier は ENTERPRISE edition 専用。
    # POSTGRES_16 は API 既定が ENTERPRISE_PLUS（db-perf-optimized-* 要・割高）ゆえ明示。
    edition = "ENTERPRISE"

    # 可用性: prod のみ REGIONAL(HA)、staging/dev は ZONAL（既定）。
    availability_type = var.availability_type

    # private IP only — public IP を割り当てない。private_network 経由でのみ到達可能。
    # private IP は network モジュールの PSA peering 上に割り当てられる（var.private_services_ready で順序強制）。
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.vpc_network_id
      # 転送時暗号化を強制（provider v6: 非 SSL/平文接続を拒否）。生徒 PII の転送経路を保護（ルール5 / NFR03）。
      # Semgrep(gcp-sql-database-ssl-insecure-value...) は mTLS(TRUSTED_CLIENT_CERTIFICATE_REQUIRED) を要求するが、
      # ENCRYPTED_ONLY は TLS を必須化済（暗号化は強制）。mTLS は NFR03/ADR で mandate されておらず、
      # かつクライアント証明書基盤が未整備（Cloud Run 未配線）ゆえ今 mandate すると接続不能になる。
      # private-IP-only(in-VPC) + TLS 強制で現フェーズ要件を充足。mTLS は app 接続方式確定時のハードニング候補
      # （README「スコープ外（Phase 後半）」）。security Reviewer(PR #578) が安全と判定済 → 根拠付き抑制。
      ssl_mode = "ENCRYPTED_ONLY" # nosemgrep: gcp-sql-database-ssl-insecure-value-postgres-mysql
    }

    # pgvector（ADR-007 RAG）は Cloud SQL の instance flag では有効化しない:
    # `cloudsql.enable_pgvector` は実在しない flag（apply 時 invalidFlagName 404）。
    # vector 拡張は migration の `CREATE EXTENSION IF NOT EXISTS vector` で DB レベルに有効化する
    # （Cloud SQL PG16 の標準サポート拡張。repo の seed/global-setup も同方式）。

    # 自動バックアップ + PITR。10 年保管・漏洩時/誤操作時の復旧要件（ADR-001）。
    # staging でも有効化し、リストア手順まで含めて検証する。
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true # PostgreSQL の PITR（WAL アーカイブ）
      start_time                     = var.backup_start_time
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    # メンテナンスウィンドウ（低負荷帯に固定し、突発的な再起動を避ける）。
    maintenance_window {
      day          = var.maintenance_window_day
      hour         = var.maintenance_window_hour
      update_track = "stable"
    }

    # GCP ネイティブ（API レベル）の削除保護。下の `deletion_protection`（Terraform メタ引数）は
    # `terraform destroy` のみを阻止するのに対し、こちらは gcloud / Console / REST API からの
    # `instances delete` も阻止する（out-of-band な誤操作・侵害時の削除に対する最後の砦）。
    # 10 年保管要件の生徒データ instance を二層で守る（同じ var で連動。prod=true、
    # dev/staging=false で recreate 容易性優先）。PR #753 reviewer INFO-1。
    deletion_protection_enabled = var.deletion_protection
  }

  # Terraform メタ引数の削除保護（`terraform destroy` のみを阻止）。
  # API レベルの削除保護は上の settings.deletion_protection_enabled（同じ var で連動）で
  # 別途有効化する（gcloud/Console/API からの delete も阻止する二層防御）。
  deletion_protection = var.deletion_protection

  # PSA peering（network モジュール）が無いと private IP only の instance は作成できない。
  # network の private_services_ready 出力を受け取り、peering 不在のまま enable する事故を
  # plan 時に fail-fast させる（peering -> instance の順序を強制。count 静的依存 = plan 時既知）。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.private_services_ready
      error_message = "enabled = true（private IP only）のとき private_services_ready = true が必須です。network モジュールの PSA peering（google_service_networking_connection）を先に enable し、その private_services_ready 出力を渡してください（peering 無しでは private IP を割り当てられず instance を作成不可、ADR-001 / ADR-021 / ルール8）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_network_id != ""
      error_message = "enabled = true（private IP only）のとき vpc_network_id は必須です。network モジュールの network_id 出力を渡してください（ルール8）。"
    }
  }
}

resource "google_sql_database" "app" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = "kimiterrace"
  instance = google_sql_database_instance.main[0].name
}

# アプリ DB ユーザー（google_sql_user.app）。
# パスワードは Secret Manager（var.app_db_password_secret_id）に「人間が」投入した値を data source で参照する
# （ルール5: Terraform はパスワードを生成・ハードコードしない。値は human-injected。secret コンテナは
#  secret_manager モジュールが作成する）。var.app_db_password_secret_id が空なら作らない（雛形・dev/prod 後方互換）。
#
# ⚠ パスワードは google_sql_user.password に入るため Terraform state（gs://signage-v2-tf-state）に保存される。
#   state バケットは uniform bucket-level access + 限定 IAM（WIF SA / breakglass のみ）で保護する前提＝accepted tradeoff。
#   パスワードレスの IAM database authentication（type = CLOUD_IAM_SERVICE_ACCOUNT）への移行は app 接続方式
#   確定後のハードニング follow-up（README「スコープ外（Phase 後半）」・本モジュール元 TODO）。
locals {
  create_app_user      = var.enabled && var.app_db_password_secret_id != ""
  create_migrator_user = var.enabled && var.migrator_db_password_secret_id != ""
}

# 人間が投入した DB パスワードの最新版を参照（version = "latest"）。
# 2-phase apply の ③ で読む。① の -target=module.secret_manager では本 data source はグラフから外れ読まれない。
# ⚠ secret/project は静的ゆえ Terraform は plan 時に本 data source を読む。① と ② の間に full `terraform plan`/
#   `apply` を実行すると version 不在で失敗する → 必ず ②（人間が値投入）→③ の順を守る（CI は plan しないので緑）。
data "google_secret_manager_secret_version" "app_db_password" {
  count = local.create_app_user ? 1 : 0

  project = var.project_id
  secret  = var.app_db_password_secret_id
  version = "latest"
}

resource "google_sql_user" "app" {
  count = local.create_app_user ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.main[0].name # instance 作成後に user を作る（順序強制）
  name     = "app"
  password = data.google_secret_manager_secret_version.app_db_password[0].secret_data
}

# migrator DB ユーザー（migration 実行用・テーブル所有者）。app と同じ data source 方式。
# Cloud SQL の API 作成 user は cloudsqlsuperuser ゆえ CREATE EXTENSION / CREATE ROLE 可。
# 2-phase apply: ① -target=module.secret_manager で secret コンテナ作成 → ② 人間が値投入 → ③ full apply で user 作成。
data "google_secret_manager_secret_version" "migrator_db_password" {
  count = local.create_migrator_user ? 1 : 0

  project = var.project_id
  secret  = var.migrator_db_password_secret_id
  version = "latest"
}

resource "google_sql_user" "migrator" {
  count = local.create_migrator_user ? 1 : 0

  project  = var.project_id
  instance = google_sql_database_instance.main[0].name # instance 作成後に user を作る（順序強制）
  name     = "migrator"
  password = data.google_secret_manager_secret_version.migrator_db_password[0].secret_data
}
