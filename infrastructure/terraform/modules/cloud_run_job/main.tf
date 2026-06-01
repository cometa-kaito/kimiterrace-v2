# Cloud Run Job + Cloud Scheduler 雛形（F06 embedding バッチ / #416, #398, #365, #42）
#
# 対象: 公開コンテンツの embedding 生成バッチ（apps/jobs/src/embedding/embed-job.ts）。
# 全校横断ドライバ（run.ts `embedAllSchools`）を Cloud Run Job として定期実行する。
#
# 設計方針（CLAUDE.md ルール準拠）:
# - ルール2: DATABASE_URL は **kimiterrace_app ロール（非 BYPASSRLS）**。各校 school_admin
#   コンテキストに降格して RLS を効かせる前提（run.ts のドライバ責務）。Job 側は接続文字列を
#   Secret Manager から注入するだけ。
# - ルール4: PII マスク後に embedding 生成（バッチ本体の責務）。Job は env / 権限のみ担う。
# - ルール5: secret は Secret Manager のみ。**JSON キーファイル禁止** — Job は専用 runtime SA
#   として Workload Identity で実行する。DATABASE_URL は value_source.secret_key_ref で注入。
# - ルール8: すべて Terraform 管理。コンソール直接変更は緊急時のみ。
#
# 雛形段階は `enabled = false`（count = 0）で実体を生成しない（既存 cloud_run モジュールと同規律）。
# image / vpc_connector / database_url_secret_id 等は Phase 開発で値を詰めて enabled = true に切替。

locals {
  # 1 校スコープで走る軽量バッチ。Phase 開発で実測に合わせて調整する。
  scheduler_job_name = "${var.job_name}-trigger"
}

# ── 実行用 SA（最小権限）─────────────────────────────────────────────
# Vertex AI embedding 呼び出し + Cloud SQL 接続 + DATABASE_URL secret 読取のみ。
resource "google_service_account" "job_runtime" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sa"
  display_name = "F06 embedding batch runtime SA (${var.env})"
  description  = "Cloud Run Job (embedding batch) の実行 SA。Vertex AI + Cloud SQL + DATABASE_URL secret に最小権限。"
}

# Vertex AI（テキスト embedding 生成、ADR-005 / ADR-007）。
resource "google_project_iam_member" "runtime_vertex_user" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# Cloud SQL 接続（ADR-001）。private IP + VPC egress で接続する前提。
resource "google_project_iam_member" "runtime_cloudsql_client" {
  count = var.enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# DATABASE_URL secret の accessor（**該当 secret のみ** = 最小権限、ルール5）。
resource "google_secret_manager_secret_iam_member" "runtime_database_url" {
  count = var.enabled && var.database_url_secret_id != "" ? 1 : 0

  project   = var.project_id
  secret_id = var.database_url_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job_runtime[0].email}"
}

# ── Cloud Run Job ───────────────────────────────────────────────────
resource "google_cloud_run_v2_job" "embedding" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = var.job_name

  # 雛形段階での誤 destroy ガードは enabled スイッチ側で担う。Phase 開発で要件に応じ true 化を検討。
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.job_runtime[0].email
      max_retries     = var.max_retries
      timeout         = var.task_timeout

      containers {
        image = var.image

        # 起動コマンド = `node src/embedding/embed-job.ts` 相当。
        # コンテナイメージ内ではビルド済み JS（.js）を起動する（Dockerfile は別 PR）。
        command = var.container_command
        args    = var.container_args

        # Vertex AI の GCP プロジェクト（embed-job.ts 必須 env）。
        env {
          name  = "GCP_PROJECT"
          value = var.project_id
        }
        # NFR07 データ越境ゼロ: asia-northeast1 既定。
        env {
          name  = "VERTEX_LOCATION"
          value = var.vertex_location
        }
        # ADR-007: gemini-embedding-001@768。
        env {
          name  = "EMBEDDING_MODEL_ID"
          value = var.embedding_model_id
        }
        env {
          name  = "EMBED_BATCH_SIZE"
          value = tostring(var.embed_batch_size)
        }
        # DATABASE_URL は **Secret Manager から注入**（ルール5、ハードコード禁止）。
        # 値は kimiterrace_app ロール（非 BYPASSRLS）の DSN（ルール2）。
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

        resources {
          limits = {
            cpu    = var.cpu
            memory = var.memory
          }
        }
      }

      # Cloud SQL private IP への egress（network モジュールの VPC connector を渡す）。
      dynamic "vpc_access" {
        for_each = var.vpc_connector != "" ? [1] : []
        content {
          connector = var.vpc_connector
          egress    = "PRIVATE_RANGES_ONLY"
        }
      }
    }
  }
}

# ── Cloud Scheduler（Job を定期起動）────────────────────────────────
# 専用 SA（trigger 専用 = 最小権限）。Job 実行 API を OAuth トークンで叩く（静的鍵なし、ルール5）。
resource "google_service_account" "scheduler" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  account_id   = "${var.job_name}-sched"
  display_name = "F06 embedding batch scheduler SA (${var.env})"
  description  = "Cloud Scheduler が embedding バッチ Job を起動するための SA（run.invoker のみ）。"
}

# scheduler SA に当該 Job の起動権限のみ付与（run.jobs.run を含む roles/run.invoker）。
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.embedding[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "embedding" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = local.scheduler_job_name
  description      = "F06 embedding バッチの定期起動（#416）"
  schedule         = var.schedule
  time_zone        = var.schedule_time_zone
  attempt_deadline = "320s"

  retry_config {
    retry_count = var.scheduler_retry_count
  }

  http_target {
    http_method = "POST"
    # Cloud Run Admin API v2 の jobs:run エンドポイント。
    uri = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${var.job_name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler[0].email
    }
  }
}
