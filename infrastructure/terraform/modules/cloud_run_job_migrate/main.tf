# Cloud Run Job: DB migration runner（M3, #243 / staging bring-up）
#
# 対象: packages/db の migration（drizzle/ → migrations/）を private-IP-only な Cloud SQL に適用する。
# image = migrate-cli（infrastructure/docker/migrate.Dockerfile, M2 / PR #583）。private IP ゆえローカル機
# （VPC 外）からは届かないので、VPC connector 経由で到達できる **on-demand** Cloud Run Job として実行する
# （Scheduler なし。実行は `gcloud run jobs execute <name>`）。
#
# 設計（CLAUDE.md ルール準拠）:
# - ルール2: migration は **migrator ロール（テーブル所有・cloudsqlsuperuser）** で実行する。app は非所有者
#   ゆえ SET ROLE kimiterrace_app で RLS が効く（app をテーブル所有にすると owner-bypass で RLS 無効化＝NG）。
#   Job の DATABASE_URL は **migrator DSN**（cloud_sql の google_sql_user.migrator）を指す。
# - ルール5: secret は Secret Manager のみ・JSON キー禁止。専用 runtime SA（Workload Identity）。
#   DATABASE_URL は value_source.secret_key_ref で注入。runtime SA は **当該 DSN secret のみ** accessor（最小権限）。
# - ルール8: すべて Terraform 管理。
#
# 雛形段階は enabled = false（count = 0）。
# 注: private IP への接続は VPC connector の network 経路で成立する。password 認証の **直 TCP 接続**ゆえ
#     runtime SA に cloudsql.client は不要（Cloud SQL Auth Proxy / connector lib 非使用 = 最小権限）。

# 実行用 SA（最小権限 = DSN secret accessor のみ）。
resource "google_service_account" "migrate_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sa"
  display_name = "DB migration Job runtime SA (${var.env})"
  description  = "Cloud Run Job (DB migration) の実行 SA。DATABASE_URL secret の accessor のみ（最小権限、ルール5）。"
}

# DATABASE_URL secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
resource "google_secret_manager_secret_iam_member" "runtime_database_url" {
  count = var.enabled && var.database_url_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.migrate_runtime[0].email}"
}

resource "google_cloud_run_v2_job" "migrate" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.job_name

  # 削除保護。prod は既定 true、staging/dev は env 側で false に上書き（Issue #70 同方針）。
  deletion_protection = var.deletion_protection

  template {
    template {
      service_account = google_service_account.migrate_runtime[0].email
      max_retries     = var.max_retries
      timeout         = var.task_timeout

      containers {
        # image の CMD = ["node","dist/migrate-cli.js"]（migrate.Dockerfile）。command/args は上書きしない。
        image = var.image

        # DATABASE_URL = migrator DSN（Secret Manager から注入、ルール5・ハードコード禁止）。
        dynamic "env" {
          for_each = var.database_url_secret_id != "" ? [1] : []
          content {
            name = "DATABASE_URL"
            value_source {
              secret_key_ref {
                secret  = var.database_url_secret_id
                version = "latest"
              }
            }
          }
        }

        # 任意: migration 後に `GRANT kimiterrace_app TO <member>`（app login が SET ROLE できるように）。
        # migrate-runner が MIGRATE_GRANT_APP_ROLE_MEMBER を受けて SAFE_ROLE_NAME 検証の上で発行する。
        dynamic "env" {
          for_each = var.grant_app_role_member != "" ? [1] : []
          content {
            name  = "MIGRATE_GRANT_APP_ROLE_MEMBER"
            value = var.grant_app_role_member
          }
        }

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
      }

      # Cloud SQL private IP への egress（内部のみ・Cloud NAT 不要 = 外部 API へ出ない）。
      dynamic "vpc_access" {
        for_each = var.vpc_connector != "" ? [1] : []
        content {
          connector = var.vpc_connector
          egress    = "PRIVATE_RANGES_ONLY"
        }
      }
    }
  }

  # enabled = true なのに DB creds / egress / image が未設定だと runtime で確実に失敗する → plan で fail-fast。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.database_url_secret_id != ""
      error_message = "enabled = true のとき database_url_secret_id は必須です（DATABASE_URL を Secret Manager から注入、ルール5）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_connector != ""
      error_message = "enabled = true のとき vpc_connector は必須です（Cloud SQL private IP への egress、ルール2 のテナント分離 DB に接続）。"
    }
    precondition {
      condition     = !var.enabled || var.image != ""
      error_message = "enabled = true のとき image は必須です（build/push 済の migrate イメージ、infrastructure/docker/migrate.Dockerfile）。"
    }
  }
}
